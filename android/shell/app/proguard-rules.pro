# The shell has no reflection, serialization or JavaScript interface classes; TailcatBridge exposes JNI methods.
-dontwarn org.jetbrains.annotations.**
-keep class dev.grokbot.local.TailcatBridge { *; }
-keep class dev.grokbot.local.UnifiedPushReceiver { *; }
-keep class dev.grokbot.local.ApkFileProvider { *; }
-keep class dev.grokbot.local.BootReceiver { *; }
-keep class dev.grokbot.local.NotificationService { *; }
