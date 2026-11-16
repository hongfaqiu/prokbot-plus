#include <jni.h>
#include <stddef.h>
#include "libgroktailcat.h"

static jstring take_go_string(JNIEnv *env, char *raw) {
  if (!raw) return (*env)->NewStringUTF(env, "");
  jstring out = (*env)->NewStringUTF(env, raw);
  GBTailcatFree(raw);
  return out;
}

JNIEXPORT jstring JNICALL
Java_dev_grokbot_local_TailcatBridge_nativeIdentity(JNIEnv *env, jclass clazz) {
  (void)clazz;
  return take_go_string(env, GBTailcatIdentity());
}

JNIEXPORT jstring JNICALL
Java_dev_grokbot_local_TailcatBridge_nativeStart(JNIEnv *env, jclass clazz, jstring configJson) {
  (void)clazz;
  if (!configJson) return (*env)->NewStringUTF(env, "{\"error\":\"missing configuration\"}");
  const char *utf = (*env)->GetStringUTFChars(env, configJson, NULL);
  if (!utf) return (*env)->NewStringUTF(env, "{\"error\":\"out of memory\"}");
  char *raw = GBTailcatStart((char *)utf);
  (*env)->ReleaseStringUTFChars(env, configJson, utf);
  return take_go_string(env, raw);
}

JNIEXPORT jstring JNICALL
Java_dev_grokbot_local_TailcatBridge_nativeStatus(JNIEnv *env, jclass clazz, jint handle) {
  (void)clazz;
  return take_go_string(env, GBTailcatStatus((int)handle));
}

JNIEXPORT void JNICALL
Java_dev_grokbot_local_TailcatBridge_nativeStop(JNIEnv *env, jclass clazz, jint handle) {
  (void)clazz;
  GBTailcatStop((int)handle);
}
