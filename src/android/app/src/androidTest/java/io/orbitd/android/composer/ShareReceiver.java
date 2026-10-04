package io.orbitd.android.composer;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.widget.TextView;
import java.io.InputStream;
import java.io.FileOutputStream;
import java.io.ByteArrayOutputStream;
import java.security.MessageDigest;

/** Standalone test-APK process: no dependency on the target app's Kotlin runtime. */
public class ShareReceiver extends Activity {
    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        try {
            Uri uri = getIntent().getParcelableExtra(Intent.EXTRA_STREAM);
            if (uri == null) uri = getIntent().getData();
            byte[] data;
            try (InputStream input = getContentResolver().openInputStream(uri); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[4096]; int count;
                while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
                data = output.toByteArray();
            }
            StringBuilder hash = new StringBuilder();
            for (byte b : MessageDigest.getInstance("SHA-256").digest(data)) hash.append(String.format("%02x", b));
            TextView view = new TextView(this);
            view.setText("Received file"); view.setContentDescription(hash.toString()); view.setTextSize(20);
            view.setOnClickListener(v -> {}); setContentView(view);
            try (FileOutputStream output = openFileOutput("a07-received.txt", MODE_PRIVATE)) {
                output.write((hash + "\n" + data.length + "\n" + getIntent().getType() + "\nuid=" + android.os.Process.myUid() + "\naction=" + getIntent().getAction()).getBytes(java.nio.charset.StandardCharsets.UTF_8));
            }
        } catch (Exception error) { throw new IllegalStateException("URI recipient failed", error); }
    }
}
