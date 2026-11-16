package dev.grokbot.local

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import java.io.File
import java.io.FileNotFoundException

/** Read-only ContentProvider exposing verified update APKs from filesDir/updates/. */
class ApkFileProvider : ContentProvider() {
    override fun onCreate(): Boolean = true

    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?,
    ): Cursor {
        val file = resolve(uri) ?: throw FileNotFoundException("Invalid APK URI")
        val cols = projection ?: arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
        val cursor = MatrixCursor(cols, 1)
        val row = Array<Any?>(cols.size) { idx ->
            when (cols[idx]) {
                OpenableColumns.DISPLAY_NAME -> file.name
                OpenableColumns.SIZE -> file.length()
                else -> null
            }
        }
        cursor.addRow(row)
        return cursor
    }

    override fun getType(uri: Uri): String = "application/vnd.android.package-archive"

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        if (mode != "r") throw FileNotFoundException("Read-only provider")
        val file = resolve(uri) ?: throw FileNotFoundException("APK not found")
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri? =
        throw UnsupportedOperationException("Read-only provider")

    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int =
        throw UnsupportedOperationException("Read-only provider")

    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int =
        throw UnsupportedOperationException("Read-only provider")

    private fun resolve(uri: Uri): File? {
        val ctx = context ?: return null
        if (uri.authority != authority(ctx)) return null
        val segments = uri.pathSegments
        if (segments.size != 2 || segments[0] != "updates") return null
        val filename = segments[1]
        if (!SAFE_APK_NAME.matches(filename)) return null
        val dir = File(ctx.filesDir, "updates").canonicalFile
        val file = File(dir, filename).canonicalFile
        if (!file.path.startsWith(dir.path + File.separator) || !file.isFile) return null
        return file
    }

    companion object {
        private val SAFE_APK_NAME = Regex("^[A-Za-z0-9._-]+\\.apk$")
        fun authority(context: Context): String = "${context.packageName}.apkprovider"
        fun uriFor(context: Context, file: File): Uri =
            Uri.Builder()
                .scheme("content")
                .authority(authority(context))
                .appendPath("updates")
                .appendPath(file.name)
                .build()
    }
}
