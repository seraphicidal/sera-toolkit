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

data class SecretDecryptResult(
    val value: String,
    val failed: Boolean,
)

object SecretCipher {
    private const val PREFIX = "enc:v1:"
    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    private const val KEY_ALIAS = "sera_node_secrets_v1"
    private const val TRANSFORMATION = "AES/GCM/NoPadding"
    private const val IV_LENGTH_BYTES = 12
    private const val TAG_LENGTH_BITS = 128

    private val lock = Any()
    private val secureRandom = SecureRandom()

    fun isEncrypted(stored: String): Boolean = stored.startsWith(PREFIX)

    fun isKeyStoreAvailable(): Boolean = isAndroidKeyStoreAvailable()

    fun encrypt(plaintext: String): String {
        if (plaintext.isEmpty()) return ""
        if (plaintext.startsWith(PREFIX)) return plaintext
        val key = getOrCreateKey() ?: return plaintext
        return encryptWithKey(plaintext, key, useKeystoreIv = true)
    }

    fun decrypt(stored: String): String = decryptWithStatus(stored).value

    fun decryptWithStatus(stored: String): SecretDecryptResult {
        if (stored.isEmpty()) return SecretDecryptResult("", failed = false)
        if (!stored.startsWith(PREFIX)) return SecretDecryptResult(stored, failed = false)
        if (!isAndroidKeyStoreAvailable()) return SecretDecryptResult("", failed = true)
        for (attempt in 1..2) {
            val key = getOrCreateKey() ?: continue
            val result = decryptWithKey(stored, key)
            if (!result.failed) return result
        }
        return SecretDecryptResult("", failed = true)
    }

    internal fun encryptWithKey(
        plaintext: String,
        key: SecretKey,
        useKeystoreIv: Boolean = false,
    ): String {
        if (plaintext.isEmpty()) return ""
        if (plaintext.startsWith(PREFIX)) return plaintext
        return try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            val iv = if (useKeystoreIv) {
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

    internal fun decryptWithKey(stored: String, key: SecretKey): SecretDecryptResult {
        if (stored.isEmpty()) return SecretDecryptResult("", failed = false)
        if (!stored.startsWith(PREFIX)) return SecretDecryptResult(stored, failed = false)
        val payload = try {
            Base64.getDecoder().decode(stored.removePrefix(PREFIX))
        } catch (_: Exception) {
            return SecretDecryptResult("", failed = true)
        }
        if (payload.size <= IV_LENGTH_BYTES) return SecretDecryptResult("", failed = true)
        val iv = payload.copyOfRange(0, IV_LENGTH_BYTES)
        val ciphertext = payload.copyOfRange(IV_LENGTH_BYTES, payload.size)
        return try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_LENGTH_BITS, iv))
            SecretDecryptResult(String(cipher.doFinal(ciphertext), Charsets.UTF_8), failed = false)
        } catch (_: Exception) {
            SecretDecryptResult("", failed = true)
        }
    }

    private fun isAndroidKeyStoreAvailable(): Boolean {
        return runCatching {
            KeyStore.getInstance(ANDROID_KEYSTORE)
            true
        }.getOrDefault(false)
    }

    private fun getOrCreateKey(): SecretKey? {
        return synchronized(lock) {
            if (!isAndroidKeyStoreAvailable()) {
                return@synchronized null
            }
            runCatching {
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
    }
}
