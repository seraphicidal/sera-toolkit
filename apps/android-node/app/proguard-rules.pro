-keepattributes Signature,InnerClasses,EnclosingMethod
-keepattributes RuntimeVisibleAnnotations,RuntimeVisibleParameterAnnotations
-keepclassmembers,allowobfuscation class * {
    @kotlinx.serialization.SerialName <fields>;
}
-keep,includedescriptorclasses class dev.sera.node.model.** { *; }
-keep,includedescriptorclasses @kotlinx.serialization.Serializable class dev.sera.node.** { *; }
-keep,includedescriptorclasses class dev.sera.node.**$$serializer { *; }
-keepclassmembers class dev.sera.node.** {
    *** Companion;
}
-keepclasseswithmembers class dev.sera.node.** {
    kotlinx.serialization.KSerializer serializer(...);
}
-keep class com.yausername.** { *; }
-keep class org.apache.commons.** { *; }
-keep class com.fasterxml.jackson.** { *; }
-dontwarn com.fasterxml.jackson.**
-dontwarn org.apache.commons.**
