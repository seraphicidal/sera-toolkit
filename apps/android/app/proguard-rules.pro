-keepattributes Signature,InnerClasses,EnclosingMethod
-keepattributes RuntimeVisibleAnnotations,RuntimeVisibleParameterAnnotations
-keepclassmembers,allowobfuscation class * {
    @kotlinx.serialization.SerialName <fields>;
}
-keep,includedescriptorclasses class dev.sera.toolkit.model.** { *; }
-keep,includedescriptorclasses class dev.sera.toolkit.domain.HistoryEntry { *; }
-keep,includedescriptorclasses class dev.sera.toolkit.domain.HistoryEntry$Companion { *; }
-keep,includedescriptorclasses class dev.sera.toolkit.data.DownloadTaskRecord { *; }
-keep,includedescriptorclasses class dev.sera.toolkit.data.DownloadTaskRecord$Companion { *; }
-keep,includedescriptorclasses class dev.sera.toolkit.data.DownloadTaskStatus { *; }
-keep,includedescriptorclasses class dev.sera.toolkit.data.DownloadTaskStatus$Companion { *; }
-keep,includedescriptorclasses class dev.sera.toolkit.data.GitHubReleaseDto { *; }
-keep,includedescriptorclasses class dev.sera.toolkit.data.GitHubReleaseDto$Companion { *; }
