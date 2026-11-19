-keepattributes Signature,InnerClasses,EnclosingMethod
-keepattributes RuntimeVisibleAnnotations,RuntimeVisibleParameterAnnotations
-keepclassmembers,allowobfuscation class * {
    @kotlinx.serialization.SerialName <fields>;
}
-keep,includedescriptorclasses class dev.sera.toolkit.model.** { *; }
-keep,includedescriptorclasses class dev.sera.toolkit.domain.HistoryEntry { *; }
-keep,includedescriptorclasses class dev.sera.toolkit.domain.HistoryEntry$Companion { *; }
