# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: toasts-lifecycle.browser.mjs >> notification card stays fixed through Dialog entry, nested layers and exit
- Location: src/web/ui-migration/toasts-lifecycle.browser.mjs:94:3

# Error details

```
Error: existing card DOM, opacity and geometry stay stable at every sampled frame

expect(received).toEqual(expected) // deep equality

- Expected  -    1
+ Received  + 2084

- Array []
+ Array [
+   Object {
+     "card": Object {
+       "bottom": 188,
+       "height": 144,
+       "left": 16,
+       "right": 366,
+       "top": 44,
+       "width": 350,
+       "x": 16,
+       "y": 44,
+     },
+     "opacity": "0",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0",
+         "scale": "0.9",
+         "translate": "none",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 937,
+   },
+   Object {
+     "card": Object {
+       "bottom": 198.0623664855957,
+       "height": 144,
+       "left": 16,
+       "right": 366,
+       "top": 54.0623664855957,
+       "width": 350,
+       "x": 16,
+       "y": 54.0623664855957,
+     },
+     "opacity": "0.838531",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0",
+         "scale": "0.9",
+         "translate": "none",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 992,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.9805030822754,
+       "height": 144,
+       "left": 16,
+       "right": 366,
+       "top": 55.98050308227539,
+       "width": 350,
+       "x": 16,
+       "y": 55.98050308227539,
+     },
+     "opacity": "0.998375",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.821567",
+         "scale": "0.982157",
+         "translate": "none",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 1095,
+   },
+   Object {
+     "card": Object {
+       "bottom": 188,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 44,
+       "width": 358,
+       "x": 16,
+       "y": 44,
+     },
+     "opacity": "0",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0",
+         "scale": "0.9",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1253,
+   },
+   Object {
+     "card": Object {
+       "bottom": 194.33051681518555,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 50.33051681518555,
+       "width": 358,
+       "x": 16,
+       "y": 50.33051681518555,
+     },
+     "opacity": "0.527543",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0",
+         "scale": "0.9",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1278,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.7762336730957,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.7762336730957,
+       "width": 358,
+       "x": 16,
+       "y": 55.7762336730957,
+     },
+     "opacity": "0.981353",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.776371",
+         "scale": "0.977637",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1372,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.96905899047852,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.969058990478516,
+       "width": 358,
+       "x": 16,
+       "y": 55.969058990478516,
+     },
+     "opacity": "0.997422",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.915934",
+         "scale": "0.991593",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1407,
+   },
+   Object {
+     "card": Object {
+       "bottom": 200,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 56,
+       "width": 358,
+       "x": 16,
+       "y": 56,
+     },
+     "opacity": "1",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.98054",
+         "scale": "0.997937",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1440,
+   },
+   Object {
+     "card": Object {
+       "bottom": 200,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 56,
+       "width": 358,
+       "x": 16,
+       "y": 56,
+     },
+     "opacity": "1",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1493,
+   },
+   Object {
+     "card": Object {
+       "bottom": 200,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 56,
+       "width": 358,
+       "x": 16,
+       "y": 56,
+     },
+     "opacity": "1",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1530,
+   },
+   Object {
+     "card": Object {
+       "bottom": 200,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 56,
+       "width": 358,
+       "x": 16,
+       "y": 56,
+     },
+     "opacity": "1",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1537,
+   },
+   Object {
+     "card": Object {
+       "bottom": 200,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 56,
+       "width": 358,
+       "x": 16,
+       "y": 56,
+     },
+     "opacity": "1",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1554,
+   },
+   Object {
+     "card": Object {
+       "bottom": 200,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 56,
+       "width": 358,
+       "x": 16,
+       "y": 56,
+     },
+     "opacity": "1",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1569,
+   },
+   Object {
+     "card": Object {
+       "bottom": 200,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 56,
+       "width": 358,
+       "x": 16,
+       "y": 56,
+     },
+     "opacity": "1",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1585,
+   },
+   Object {
+     "card": Object {
+       "bottom": 200,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 56,
+       "width": 358,
+       "x": 16,
+       "y": 56,
+     },
+     "opacity": "1",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1586,
+   },
+   Object {
+     "card": Object {
+       "bottom": 188,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 44,
+       "width": 358,
+       "x": 16,
+       "y": 44,
+     },
+     "opacity": "0",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0",
+         "scale": "0.9",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1605,
+   },
+   Object {
+     "card": Object {
+       "bottom": 195.59449768066406,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 51.59449768066406,
+       "width": 358,
+       "x": 16,
+       "y": 51.59449768066406,
+     },
+     "opacity": "0.632875",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0",
+         "scale": "0.9",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1636,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.80287170410156,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.80287170410156,
+       "width": 358,
+       "x": 16,
+       "y": 55.80287170410156,
+     },
+     "opacity": "0.983573",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.753765",
+         "scale": "0.975377",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1726,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.9663963317871,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.96639633178711,
+       "width": 358,
+       "x": 16,
+       "y": 55.96639633178711,
+     },
+     "opacity": "0.9972",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.891881",
+         "scale": "0.989188",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1757,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.9974021911621,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.99740219116211,
+       "width": 358,
+       "x": 16,
+       "y": 55.99740219116211,
+     },
+     "opacity": "0.999784",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.942954",
+         "scale": "0.994295",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1776,
+   },
+   Object {
+     "card": Object {
+       "bottom": 200,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 56,
+       "width": 358,
+       "x": 16,
+       "y": 56,
+     },
+     "opacity": "1",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.983822",
+         "scale": "0.998382",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1802,
+   },
+   Object {
+     "card": Object {
+       "bottom": 200,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 56,
+       "width": 358,
+       "x": 16,
+       "y": 56,
+     },
+     "opacity": "1",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.99833",
+         "scale": "0.999833",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1824,
+   },
+   Object {
+     "card": Object {
+       "bottom": 200,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 56,
+       "width": 358,
+       "x": 16,
+       "y": 56,
+     },
+     "opacity": "1",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1846,
+   },
+   Object {
+     "card": Object {
+       "bottom": 200,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 56,
+       "width": 358,
+       "x": 16,
+       "y": 56,
+     },
+     "opacity": "1",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1863,
+   },
+   Object {
+     "card": Object {
+       "bottom": 200,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 56,
+       "width": 358,
+       "x": 16,
+       "y": 56,
+     },
+     "opacity": "1",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1866,
+   },
+   Object {
+     "card": Object {
+       "bottom": 200,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 56,
+       "width": 358,
+       "x": 16,
+       "y": 56,
+     },
+     "opacity": "1",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1882,
+   },
+   Object {
+     "card": Object {
+       "bottom": 200,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 56,
+       "width": 358,
+       "x": 16,
+       "y": 56,
+     },
+     "opacity": "1",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1896,
+   },
+   Object {
+     "card": Object {
+       "bottom": 200,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 56,
+       "width": 358,
+       "x": 16,
+       "y": 56,
+     },
+     "opacity": "1",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1912,
+   },
+   Object {
+     "card": Object {
+       "bottom": 200,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 56,
+       "width": 358,
+       "x": 16,
+       "y": 56,
+     },
+     "opacity": "1",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1929,
+   },
+   Object {
+     "card": Object {
+       "bottom": 188,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 44,
+       "width": 358,
+       "x": 16,
+       "y": 44,
+     },
+     "opacity": "0",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "1",
+         "scale": "1",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 1953,
+   },
+   Object {
+     "card": Object {
+       "bottom": 196.90507888793945,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 52.90507888793945,
+       "width": 358,
+       "x": 16,
+       "y": 52.90507888793945,
+     },
+     "opacity": "0.74209",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.681895",
+         "scale": "0.968189",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 1994,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.37418746948242,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.37418746948242,
+       "width": 358,
+       "x": 16,
+       "y": 55.37418746948242,
+     },
+     "opacity": "0.947849",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.246235",
+         "scale": "0.924623",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2043,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.61529159545898,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.615291595458984,
+       "width": 358,
+       "x": 16,
+       "y": 55.615291595458984,
+     },
+     "opacity": "0.96909",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.169374",
+         "scale": "0.916937",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2058,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.79425811767578,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.79425811767578,
+       "width": 358,
+       "x": 16,
+       "y": 55.79425811767578,
+     },
+     "opacity": "0.982855",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.111412",
+         "scale": "0.911141",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2073,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.90407943725586,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.90407943725586,
+       "width": 358,
+       "x": 16,
+       "y": 55.90407943725586,
+     },
+     "opacity": "0.992006",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.066115",
+         "scale": "0.906611",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2089,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.9715919494629,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.97159194946289,
+       "width": 358,
+       "x": 16,
+       "y": 55.97159194946289,
+     },
+     "opacity": "0.997633",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.031426",
+         "scale": "0.903143",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2107,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.9949951171875,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.9949951171875,
+       "width": 358,
+       "x": 16,
+       "y": 55.9949951171875,
+     },
+     "opacity": "0.999583",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.014176",
+         "scale": "0.901418",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2121,
+   },
+   Object {
+     "card": Object {
+       "bottom": 200,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 56,
+       "width": 358,
+       "x": 16,
+       "y": 56,
+     },
+     "opacity": "1",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.002731",
+         "scale": "0.900273",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2138,
+   },
+   Object {
+     "card": Object {
+       "bottom": 200,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 56,
+       "width": 358,
+       "x": 16,
+       "y": 56,
+     },
+     "opacity": "1",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2157,
+   },
+   Object {
+     "card": Object {
+       "bottom": 192.76032257080078,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 48.76032257080078,
+       "width": 358,
+       "x": 16,
+       "y": 48.76032257080078,
+     },
+     "opacity": "0.396694",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.912753",
+         "scale": "0.991275",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2194,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.18561172485352,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.185611724853516,
+       "width": 358,
+       "x": 16,
+       "y": 55.185611724853516,
+     },
+     "opacity": "0.932134",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.296635",
+         "scale": "0.929664",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2259,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.58649063110352,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.586490631103516,
+       "width": 358,
+       "x": 16,
+       "y": 55.586490631103516,
+     },
+     "opacity": "0.965541",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.183091",
+         "scale": "0.918309",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2279,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.70396423339844,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.70396423339844,
+       "width": 358,
+       "x": 16,
+       "y": 55.70396423339844,
+     },
+     "opacity": "0.97533",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.144161",
+         "scale": "0.914416",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2288,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.84930038452148,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.849300384521484,
+       "width": 358,
+       "x": 16,
+       "y": 55.849300384521484,
+     },
+     "opacity": "0.987442",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.089711",
+         "scale": "0.908971",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2304,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.93624114990234,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.936241149902344,
+       "width": 358,
+       "x": 16,
+       "y": 55.936241149902344,
+     },
+     "opacity": "0.994687",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.050778",
+         "scale": "0.905078",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2320,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.9996452331543,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.9996452331543,
+       "width": 358,
+       "x": 16,
+       "y": 55.9996452331543,
+     },
+     "opacity": "0.99997",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.007592",
+         "scale": "0.900759",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2353,
+   },
+   Object {
+     "card": Object {
+       "bottom": 200,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 56,
+       "width": 358,
+       "x": 16,
+       "y": 56,
+     },
+     "opacity": "1",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.000668",
+         "scale": "0.900067",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2369,
+   },
+   Object {
+     "card": Object {
+       "bottom": 200,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 56,
+       "width": 358,
+       "x": 16,
+       "y": 56,
+     },
+     "opacity": "1",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2410,
+   },
+   Object {
+     "card": Object {
+       "bottom": 193.91152954101562,
+       "height": 144,
+       "left": 16,
+       "right": 366,
+       "top": 49.911529541015625,
+       "width": 350,
+       "x": 16,
+       "y": 49.911529541015625,
+     },
+     "opacity": "0.492627",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.880792",
+         "scale": "0.988079",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2503,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.35295486450195,
+       "height": 144,
+       "left": 16,
+       "right": 366,
+       "top": 55.35295486450195,
+       "width": 350,
+       "x": 16,
+       "y": 55.35295486450195,
+     },
+     "opacity": "0.946079",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.252147",
+         "scale": "0.925215",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2570,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.523681640625,
+       "height": 144,
+       "left": 16,
+       "right": 366,
+       "top": 55.523681640625,
+       "width": 350,
+       "x": 16,
+       "y": 55.523681640625,
+     },
+     "opacity": "0.960307",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.202613",
+         "scale": "0.920261",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2579,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.74708557128906,
+       "height": 144,
+       "left": 16,
+       "right": 366,
+       "top": 55.74708557128906,
+       "width": 350,
+       "x": 16,
+       "y": 55.74708557128906,
+     },
+     "opacity": "0.978924",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.128892",
+         "scale": "0.912889",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2596,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.87568283081055,
+       "height": 144,
+       "left": 16,
+       "right": 366,
+       "top": 55.87568283081055,
+       "width": 350,
+       "x": 16,
+       "y": 55.87568283081055,
+     },
+     "opacity": "0.98964",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.078656",
+         "scale": "0.907866",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2612,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.94759368896484,
+       "height": 144,
+       "left": 16,
+       "right": 366,
+       "top": 55.947593688964844,
+       "width": 350,
+       "x": 16,
+       "y": 55.947593688964844,
+     },
+     "opacity": "0.995633",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.044948",
+         "scale": "0.904495",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2627,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.98756408691406,
+       "height": 144,
+       "left": 16,
+       "right": 366,
+       "top": 55.98756408691406,
+       "width": 350,
+       "x": 16,
+       "y": 55.98756408691406,
+     },
+     "opacity": "0.998964",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.02063",
+         "scale": "0.902063",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2643,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.99996185302734,
+       "height": 144,
+       "left": 16,
+       "right": 366,
+       "top": 55.999961853027344,
+       "width": 350,
+       "x": 16,
+       "y": 55.999961853027344,
+     },
+     "opacity": "0.999997",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.006287",
+         "scale": "0.900629",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2659,
+   },
+ ]
```

# Page snapshot

```yaml
- generic [ref=e1]:
  - main [ref=e4]:
    - heading "Notification integration" [level=1] [ref=e5]
    - status [ref=e6]: light
    - status "Location" [ref=e7]: /ui-migration/toasts.html
    - generic [ref=e8]:
      - button "Short notice" [ref=e9] [cursor=pointer]
      - button "Error notice" [ref=e11] [cursor=pointer]
      - button "Warning notice" [ref=e13] [cursor=pointer]
      - button "Complete session" [ref=e15] [cursor=pointer]
      - button "Session result" [ref=e17] [cursor=pointer]
      - button "Session failure" [ref=e19] [cursor=pointer]
      - button "Clear notifications" [ref=e21] [cursor=pointer]
      - button "Switch theme" [ref=e23] [cursor=pointer]
      - button "Nested dialog" [ref=e25] [cursor=pointer]
      - button "Confirm save" [ref=e27] [cursor=pointer]
    - status "Undo count" [ref=e29]: "0"
    - button "Open Dialog" [active] [ref=e30] [cursor=pointer]
    - button "Open Drawer" [ref=e32] [cursor=pointer]
    - button "Open Bottom drawer" [ref=e34] [cursor=pointer]
    - button "Open Retained dialog" [ref=e36] [cursor=pointer]
    - button "Legacy confirm" [ref=e38] [cursor=pointer]
  - generic [ref=e40]: Couldn't save the schedule. revision 12 is stale
  - generic:
    - region "Notifications":
      - generic [ref=e41]:
        - generic [ref=e42]:
          - generic [ref=e46]: Couldn't save the schedule
          - button "Dismiss" [ref=e48] [cursor=pointer]:
            - img "close" [ref=e49]
        - generic [ref=e52]: revision 12 is stale
        - button "Copy error" [ref=e54] [cursor=pointer]
```

# Test source

```ts
  36  |     });
  37  |     await button(page, `Open ${kind}`).click();
  38  |     await page.waitForFunction(() => window.motionDone);
  39  |     const samples = await page.evaluate(() => window.motionSamples);
  40  |     const shifted = samples.filter(s => Math.abs(s.x - before.x) > 1 || Math.abs(s.y - before.y) > 1);
  41  |     await info.attach('entry-geometry', { body: JSON.stringify({ kind, before, samples, shifted }, null, 2), contentType: 'application/json' });
  42  |     expect(shifted, 'an existing notification should not move with the newly opening modal').toHaveLength(0);
  43  |   });
  44  | }
  45  | 
  46  | test('hover pause releases after a keyboard opened and closed overlay changes portal', async ({ page }, info) => {
  47  |   await page.clock.install({ time: new Date('2026-10-04T00:00:00Z') });
  48  |   await page.clock.pauseAt(new Date('2026-10-04T00:00:01Z'));
  49  |   await button(page, 'Complete session').click();
  50  |   const region = page.locator('.toast-viewport');
  51  |   await region.locator('button[aria-label="Undo completing Fix login redirect"]').hover();
  52  |   await page.clock.runFor(10000);
  53  |   await expect(region).toBeVisible();
  54  |   await button(page, 'Open Dialog').focus();
  55  |   await page.keyboard.press('Enter');
  56  |   await page.clock.runFor(200);
  57  |   await expect(page.getByRole('dialog', { name: 'Workspace editor', exact: true })).toBeVisible();
  58  |   await page.keyboard.press('Escape');
  59  |   await page.clock.runFor(200);
  60  |   await expect(page.getByRole('dialog', { name: 'Workspace editor', exact: true })).not.toBeVisible();
  61  |   await page.mouse.move(0, 0);
  62  |   await page.clock.runFor(6001);
  63  |   const after = await region.count();
  64  |   await info.attach('timer-after-portal', { body: JSON.stringify({ after, releasedAfterMs: 6001 }), contentType: 'application/json' });
  65  |   expect(after).toBe(0);
  66  | });
  67  | 
  68  | 
  69  | test('native hover deadline resumes after portal changes', async ({ page }, info) => {
  70  |   await button(page, 'Complete session').click();
  71  |   const region = page.locator('.toast-viewport');
  72  |   await region.locator('button[aria-label="Undo completing Fix login redirect"]').hover();
  73  |   await button(page, 'Open Dialog').focus();
  74  |   await page.keyboard.press('Enter');
  75  |   await expect(page.getByRole('dialog', { name: 'Workspace editor', exact: true })).toBeVisible();
  76  |   await page.keyboard.press('Escape');
  77  |   await expect(page.getByRole('dialog', { name: 'Workspace editor', exact: true })).not.toBeVisible();
  78  |   await page.mouse.move(0, 0);
  79  |   const releasedAt = Date.now();
  80  |   try { await expect(region).toHaveCount(0, { timeout: 7500 }); }
  81  |   finally {
  82  |     await info.attach('native-timer', {body: JSON.stringify({ elapsedMs:Date.now()-releasedAt, count:await region.count() }), contentType:'application/json'});
  83  |   }
  84  | });
  85  | 
  86  | const region = (page) => page.getByRole('region', { name: 'Notifications', exact: true });
  87  | const attach = (info, name, value) => info.attach(name, { body: JSON.stringify(value, null, 2), contentType: 'application/json' });
  88  | const finishMotion = (page) => page.evaluate(async () => {
  89  |   await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  90  |   await Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {})));
  91  | });
  92  | 
  93  | for (const kind of ['Dialog', 'Drawer', 'Bottom drawer']) {
  94  |   test(`notification card stays fixed through ${kind} entry, nested layers and exit`, async ({ page }, info) => {
  95  |     await page.emulateMedia({ reducedMotion: 'no-preference' });
  96  |     await button(page, 'Error notice').click();
  97  |     await page.mouse.move(0, 0);
  98  |     await finishMotion(page);
  99  |     await page.evaluate(() => {
  100 |       const card = document.querySelector('.toast');
  101 |       window.cardMotion = { before: card.getBoundingClientRect().toJSON(), samples: [], phase: 'before', running: true };
  102 |       const sample = () => {
  103 |         const current = document.querySelector('.toast');
  104 |         const r = current?.getBoundingClientRect();
  105 |         window.cardMotion.samples.push({ phase: window.cardMotion.phase, t: performance.now(), sameNode: current === card,
  106 |           card: r?.toJSON(), opacity: current ? getComputedStyle(current).opacity : null,
  107 |           overlays: [...document.querySelectorAll('.orbit-overlay')].map((el) => {
  108 |             const s = getComputedStyle(el);
  109 |             return { scale: s.scale, translate: s.translate, opacity: s.opacity, ending: el.hasAttribute('data-ending-style') };
  110 |           }) });
  111 |         if (window.cardMotion.running) requestAnimationFrame(sample);
  112 |       };
  113 |       requestAnimationFrame(sample);
  114 |     });
  115 |     const phase = (name) => page.evaluate((value) => { window.cardMotion.phase = value; }, name);
  116 |     await phase('open');
  117 |     await button(page, `Open ${kind}`).click();
  118 |     await finishMotion(page);
  119 |     for (let depth = 1; depth <= 2; depth++) {
  120 |       await phase(`nested-${depth}`);
  121 |       await button(page, 'Nested dialog').click();
  122 |       await finishMotion(page);
  123 |       await expect(region(page)).toBeVisible();
  124 |     }
  125 |     for (let depth = 2; depth >= 0; depth--) {
  126 |       await phase(`close-${depth}`);
  127 |       await page.keyboard.press('Escape');
  128 |       await finishMotion(page);
  129 |       await expect(region(page)).toBeVisible();
  130 |     }
  131 |     const motion = await page.evaluate(() => { window.cardMotion.running = false; return window.cardMotion; });
  132 |     await attach(info, 'continuous-card-motion', motion);
  133 |     expect(motion.samples.length).toBeGreaterThan(20);
  134 |     const shifted = motion.samples.filter((s) => !s.sameNode || !s.card || s.opacity !== '1' ||
  135 |       ['x', 'y', 'width', 'height'].some((key) => Math.abs(s.card[key] - motion.before[key]) > 0.1));
> 136 |     expect(shifted, 'existing card DOM, opacity and geometry stay stable at every sampled frame').toEqual([]);
      |                                                                                                   ^ Error: existing card DOM, opacity and geometry stay stable at every sampled frame
  137 |     // These checks also prove the original popup transitions still run in both directions.
  138 |     for (const name of ['open', 'nested-1', 'nested-2', 'close-2', 'close-1', 'close-0']) {
  139 |       expect(motion.samples.some((s) => s.phase === name && s.overlays.some((o) =>
  140 |         Number(o.opacity) < 1 || (o.translate !== 'none' && o.translate !== '0px') || (o.scale !== 'none' && o.scale !== '1'))), name).toBe(true);
  141 |     }
  142 |     await expect(button(page, `Open ${kind}`)).toBeFocused();
  143 |   });
  144 | }
  145 | 
  146 | test('stationary hover stays paused across nested modal owners then resumes for exactly six seconds', async ({ page }, info) => {
  147 |   await page.clock.install({ time: new Date('2026-10-04T00:00:00Z') });
  148 |   await page.clock.pauseAt(new Date('2026-10-04T00:00:01Z'));
  149 |   await button(page, 'Complete session').click();
  150 |   await region(page).getByRole('button', { name: 'Undo completing Fix login redirect', exact: true }).hover();
  151 |   await page.clock.runFor(10000);
  152 |   await expect(region(page)).toBeVisible();
  153 |   for (const name of ['Open Dialog', 'Nested dialog']) {
  154 |     await button(page, name).focus();
  155 |     await page.keyboard.press('Enter');
  156 |     await page.clock.runFor(10200);
  157 |     await expect(region(page)).toBeVisible();
  158 |   }
  159 |   for (let i = 0; i < 2; i++) {
  160 |     await page.keyboard.press('Escape');
  161 |     await page.clock.runFor(10200);
  162 |     await expect(region(page)).toBeVisible();
  163 |   }
  164 |   await page.mouse.move(0, 0);
  165 |   await page.clock.runFor(5999);
  166 |   await expect(region(page)).toBeVisible();
  167 |   await page.clock.runFor(1);
  168 |   await expect(region(page)).toHaveCount(0);
  169 |   await attach(info, 'stationary-hover', { pausedAcrossFourTransfersMs: 40800, pausedBeforeTransfersMs: 10000, visibleAfterReleaseMs: 5999, expiredAfterReleaseMs: 6000 });
  170 | });
  171 | 
  172 | test('unhovered notifications retain their original deadline through modal owner changes', async ({ page }, info) => {
  173 |   await page.clock.install({ time: new Date('2026-10-04T00:00:00Z') });
  174 |   await page.clock.pauseAt(new Date('2026-10-04T00:00:01Z'));
  175 |   await button(page, 'Complete session').click();
  176 |   await page.mouse.move(0, 0);
  177 |   await page.clock.runFor(2000);
  178 |   await button(page, 'Open Drawer').focus();
  179 |   await page.keyboard.press('Enter');
  180 |   await page.clock.runFor(200);
  181 |   await page.keyboard.press('Escape');
  182 |   await page.clock.runFor(3799);
  183 |   await expect(region(page)).toBeVisible();
  184 |   await page.clock.runFor(1);
  185 |   await expect(region(page)).toHaveCount(0);
  186 |   await attach(info, 'unchanged-deadline', { visibleAtTotalMs: 5999, expiredAtTotalMs: 6000 });
  187 | });
  188 | 
```