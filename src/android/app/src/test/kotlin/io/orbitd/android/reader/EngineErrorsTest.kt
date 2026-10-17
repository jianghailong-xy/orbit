package io.orbitd.android.reader

import org.junit.Assert.*
import org.junit.Test

/** OrbitKit's EngineErrorsTests, case for case: which prose-shaped failures fix themselves. */
class EngineErrorsTest {
    @Test fun apiErrorTextKeysOnThePrefix() {
        assertTrue(EngineErrors.isApiErrorText("API Error: 500 Internal server error"))
        assertTrue("leading whitespace is still the prefix", EngineErrors.isApiErrorText("  API Error: 529"))
        assertFalse("a reply that mentions one is an ordinary reply", EngineErrors.isApiErrorText("The API Error you asked about is a 500"))
        assertFalse(EngineErrors.isApiErrorText(null))
        assertFalse(EngineErrors.isApiErrorText(""))
    }

    @Test fun retryableOnlyForTheProvidersFaults() {
        assertTrue(EngineErrors.isRetryableApiErrorText("API Error: 529 {\"type\":\"overloaded_error\"}"))
        assertTrue(EngineErrors.isRetryableApiErrorText("API Error: 500 Internal server error"))
        assertTrue(EngineErrors.isRetryableApiErrorText("API Error: 429 rate limited"))
        assertFalse(EngineErrors.isRetryableApiErrorText("API Error: 400 prompt is too long — timeout"))
        assertFalse(EngineErrors.isRetryableApiErrorText("API Error: 401 invalid x-api-key"))
        assertFalse(EngineErrors.isRetryableApiErrorText("API Error: 404 model not found"))
    }

    @Test fun retryableReadsTheStatusOutOfTheRejectionWrapper() {
        assertTrue(EngineErrors.isRetryableApiErrorText("API Error: Request rejected (429) · This request would exceed your account's rate limit. Please try again later."))
        assertFalse("being phrased as a rejection is not what makes it retryable",
            EngineErrors.isRetryableApiErrorText("API Error: Request rejected (400) · Output blocked by content filtering policy"))
    }

    @Test fun retryableFromWordingWhenThereIsNoStatus() {
        assertTrue(EngineErrors.isRetryableApiErrorText("API Error: Connection error."))
        assertTrue(EngineErrors.isRetryableApiErrorText("API Error: connection closed mid-response"))
        assertTrue(EngineErrors.isRetryableApiErrorText("API Error: Overloaded"))
        assertFalse("an error we cannot place is not retried", EngineErrors.isRetryableApiErrorText("API Error: content filtered"))
        assertFalse("not an API error at all", EngineErrors.isRetryableApiErrorText("Connection error."))
    }

    @Test fun retryableWhenTheFallbackAfterADeadStreamFailsToo() {
        assertTrue(EngineErrors.isRetryableApiErrorText("API Error: API returned an empty or malformed response (HTTP 200) — check for a proxy or " +
            "gateway intercepting the request. This was the non-streaming retry of streaming request (no Anthropic request-id), " +
            "which failed with: watchdog; 0 stream events received."))
    }

    @Test fun retryableInARuntimesOwnWords() {
        assertTrue(EngineErrors.isRetryableApiErrorText("Selected model is at capacity. Please try a different model."))
        assertTrue(EngineErrors.isRetryableApiErrorText("  Selected model is at capacity. Please try a different model."))
        assertFalse(EngineErrors.isRetryableApiErrorText("The run died on \"Selected model is at capacity\" — retrying."))
    }

    /** A06-2 (iOS 13da1fcde): Codex giving up on a rate limit is a transient error like the others. */
    @Test fun retryableAfterCodexGivesUpOnARateLimit() {
        val rateLimit = "exceeded retry limit, last status: 429 Too Many Requests"
        assertTrue(EngineErrors.isRetryableApiErrorText("$rateLimit, request id: 95e00d6c-68cc-4d64-b4da-01a6252260c2"))
        assertTrue(EngineErrors.isRetryableApiErrorText(rateLimit))
        assertTrue(EngineErrors.isRetryableApiErrorText("  \n" + rateLimit.uppercase()))
        assertFalse("a rate limit is not a spent quota", EngineErrors.isUsageLimitErrorText(rateLimit))
        assertFalse(EngineErrors.isRetryableApiErrorText("The run failed with \"$rateLimit\"."))
        assertFalse(EngineErrors.isRetryableApiErrorText("exceeded retry limit, last status: 401 Unauthorized"))
        assertFalse(EngineErrors.isRetryableApiErrorText("exceeded retry limit, last status: 400 Bad Request"))
        assertFalse(EngineErrors.isRetryableApiErrorText("exceeded retry limit"))
    }

    @Test fun usageLimitMustOpenTheReply() {
        assertTrue(EngineErrors.isUsageLimitErrorText("You've hit your session limit · resets 6:20pm (Europe/Berlin)"))
        assertTrue(EngineErrors.isUsageLimitErrorText("You've hit your weekly limit · resets 1pm (UTC)"))
        assertTrue(EngineErrors.isUsageLimitErrorText("You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage"))
        assertFalse(EngineErrors.isUsageLimitErrorText("I checked the logs and the run failed because the account had hit your usage limit yesterday."))
    }

    @Test fun autoRetryRowsAreTitledAsTheCardIs() {
        assertEquals("Provider unavailable", EngineErrors.autoRetryTitle(false, "API Error: 529"))
        assertEquals("5-hour limit reached", EngineErrors.autoRetryTitle(true, "You've hit your session limit · resets 6:20pm (Europe/Berlin)"))
        assertEquals("Weekly limit reached", EngineErrors.autoRetryTitle(true, "You've hit your weekly limit · resets 1pm (UTC)"))
        assertEquals("Usage limit reached", EngineErrors.autoRetryTitle(true, "You've hit your usage limit."))
    }
}
