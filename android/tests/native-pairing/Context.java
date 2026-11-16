package android.content;

// Pairing.verify / Pairing.pair need a Context to select localized error strings and read deviceName in JVM tests.
public final class Context {
    public ContentResolver getContentResolver() { return null; }
}
