package dev.sera.node.data

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

object SecretCipher {
    private const val PREFIX = "enc:v1:"
    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    private const val KEY_ALIAS = "sera_node_secrets_v1"
    private const val TRANSFORMATION = "AES/GCM/NoPadding"
    private const val IV_LENGTH_BYTES = 12
    private const val TAG_LENGTH_BITS = 128

    private val lock = Any()
    private val secureRandom = SecureRandom()

    @Volatile
    private var fallbackKey: SecretKey? = null

    fun isEncrypted(stored: String): Boolean = stored.startsWith(PREFIX)

    fun encrypt(plaintext: String): String {
        if (plaintext.isEmpty()) return ""
        if (plaintext.startsWith(PREFIX)) return plaintext
        val key = getOrCreateKey() ?: return plaintext
        return try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            val iv = if (isAndroidKeyStoreAvailable()) {
                cipher.init(Cipher.ENCRYPT_MODE, key)
                cipher.iv
            } else {
                ByteArray(IV_LENGTH_BYTES).also { secureRandom.nextBytes(it) }.also { generatedIv ->
                    cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(TAG_LENGTH_BITS, generatedIv))
                }
            }
            val encrypted = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
            val combined = ByteArray(iv.size + encrypted.size)
            System.arraycopy(iv, 0, combined, 0, iv.size)
            System.arraycopy(encrypted, 0, combined, iv.size, encrypted.size)
            PREFIX + Base64.getEncoder().encodeToString(combined)
        } catch (_: Exception) {
            plaintext
        }
    }

    fun decrypt(stored: String): String {
        if (stored.isEmpty()) return ""
        if (!stored.startsWith(PREFIX)) return stored
        val payload = try {
            Base64.getDecoder().decode(stored.removePrefix(PREFIX))
        } catch (_: Exception) {
            return ""
        }
        if (payload.size <= IV_LENGTH_BYTES) return ""
        val iv = payload.copyOfRange(0, IV_LENGTH_BYTES)
        val ciphertext = payload.copyOfRange(IV_LENGTH_BYTES, payload.size)
        val maxAttempts = if (isAndroidKeyStoreAvailable()) 2 else 1
        for (attempt in 1..maxAttempts) {
            val key = getOrCreateKey() ?: continue
            val decrypted = try {
                val cipher = Cipher.getInstance(TRANSFORMATION)
                cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_LENGTH_BITS, iv))
                String(cipher.doFinal(ciphertext), Charsets.UTF_8)
            } catch (_: Exception) {
                null
            }
            if (decrypted != null) return decrypted
        }
        return ""
    }

    private fun isAndroidKeyStoreAvailable(): Boolean {
        return runCatching {
            KeyStore.getInstance(ANDROID_KEYSTORE)
            true
        }.getOrDefault(false)
    }

    private fun getOrCreateKey(): SecretKey? {
        return synchronized(lock) {
            if (isAndroidKeyStoreAvailable()) {
                return@synchronized runCatching {
                    val ks = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
                    val existing = ks.getKey(KEY_ALIAS, null) as? SecretKey
                    if (existing != null) {
                        existing
                    } else {
                        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
                        val spec = KeyGenParameterSpec.Builder(
                            KEY_ALIAS,
                            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                        )
                            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                            .setKeySize(256)
                            .build()
                        generator.init(spec)
                        generator.generateKey()
                    }
                }.getOrNull()
            }

            fallbackKey ?: runCatching {
                val generator = KeyGenerator.getInstance("AES")
                generator.init(256, secureRandom)
                generator.generateKey().also { fallbackKey = it }
            }.getOrNull()
        }
    }
}
