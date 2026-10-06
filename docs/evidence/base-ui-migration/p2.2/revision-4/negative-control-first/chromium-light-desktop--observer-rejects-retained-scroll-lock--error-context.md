# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: scroll-negative-control.browser.mjs >> observer rejects retained scroll lock
- Location: docs/evidence/base-ui-migration/p2.2/revision-4/scroll-negative-control.browser.mjs:6:42

# Error details

```
Error: page.evaluate: TypeError: Cannot read properties of null (reading 'scrollHeight')
    at eval (eval at evaluate (:311:30), <anonymous>:6:47)
    at UtilityScript.evaluate (<anonymous>:313:16)
    at UtilityScript.<anonymous> (<anonymous>:1:44)
```

# Page snapshot

```yaml
- generic [ref=e1]:
  - button "Focus target" [active] [ref=e2]
  - generic [ref=e3]: Scrollable content
```