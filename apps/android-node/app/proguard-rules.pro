-keepattributes Signature,InnerClasses,EnclosingMethod
-keepattributes RuntimeVisibleAnnotations,RuntimeVisibleParameterAnnotations
-keepclassmembers,allowobfuscation class * {
    @kotlinx.serialization.SerialName <fields>;
}
-keep,includedescriptorclasses class dev.sera.node.model.** { *; }
-keep,includedescriptorclasses class dev.sera.node.data.** { *; }
-keep,includedescriptorclasses class dev.sera.node.extractor.** { *; }
