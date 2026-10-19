package io.orbitd.android.wiki;

import android.media.AudioFormat;
import android.speech.tts.SynthesisCallback;
import android.speech.tts.SynthesisRequest;
import android.speech.tts.TextToSpeech;
import android.speech.tts.TextToSpeechService;
import android.util.Log;

/**
 * A speech engine that says nothing and writes every utterance it is asked for to logcat (tag {@link #TAG}), so the
 * TalkBack check can read what TalkBack spoke rather than guess it from the nodes. It ships in the test APK only; the
 * device script makes it the default engine for a TalkBack run (A12_TALKBACK=1) and puts the previous engine back after.
 * Java, as A07's receiver: TalkBack binds it in the test APK's own process, which has no Kotlin runtime.
 */
public class TalkBackSpeechRecorder extends TextToSpeechService {
    public static final String TAG = "A12Speech";
    private String[] language = {"eng", "USA", ""};

    @Override protected int onIsLanguageAvailable(String lang, String country, String variant) {
        if (variant != null && !variant.isEmpty()) return TextToSpeech.LANG_COUNTRY_VAR_AVAILABLE;
        if (country != null && !country.isEmpty()) return TextToSpeech.LANG_COUNTRY_AVAILABLE;
        return TextToSpeech.LANG_AVAILABLE;
    }

    @Override protected String[] onGetLanguage() {
        return language;
    }

    @Override protected int onLoadLanguage(String lang, String country, String variant) {
        language = new String[] {lang == null ? "" : lang, country == null ? "" : country, variant == null ? "" : variant};
        return onIsLanguageAvailable(lang, country, variant);
    }

    @Override protected void onStop() {
    }

    @Override protected void onSynthesizeText(SynthesisRequest request, SynthesisCallback callback) {
        CharSequence text = request.getCharSequenceText();
        Log.i(TAG, text == null ? "" : text.toString().replace('\n', ' '));
        callback.start(16000, AudioFormat.ENCODING_PCM_16BIT, 1);
        callback.done();
    }
}
