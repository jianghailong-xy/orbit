# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: toasts-lifecycle.browser.mjs >> notification card stays fixed through Bottom drawer entry, nested layers and exit
- Location: ui-migration/toasts-lifecycle.browser.mjs:96:3

# Error details

```
Error: existing card DOM, opacity and geometry stay stable at every sampled frame

expect(received).toEqual(expected) // deep equality

- Expected  -    1
+ Received  + 5570

- Array []
+ Array [
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 12440,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 12499,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 12512,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 12528,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 12544,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 12561,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 12576,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 12593,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 12609,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 12625,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 12641,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 12657,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 12673,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 12689,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 12705,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 12721,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 12737,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 12753,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 12769,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 12785,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 12802,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 12818,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 12834,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 12850,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 12866,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 12882,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 12898,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 12914,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 12930,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 12946,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 12966,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 12983,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 12998,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 13014,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 13030,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 13046,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 13062,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 13078,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 13094,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 13110,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 13127,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 13143,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 13159,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 13175,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 13191,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 13207,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 13223,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 13239,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 13255,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 13271,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 13287,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 13303,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 13319,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 13335,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 13352,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 13368,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 13384,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 13400,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 13417,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 13432,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 13448,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 13464,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 13481,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 13497,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 13513,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 13529,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 13545,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 13561,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 13577,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 13593,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 13609,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 13625,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 13641,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "phase": "close-2",
+     "sameNode": false,
+     "t": 13657,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "phase": "close-2",
+     "sameNode": false,
+     "t": 13673,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "phase": "close-2",
+     "sameNode": false,
+     "t": 13689,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "phase": "close-2",
+     "sameNode": false,
+     "t": 13706,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+         "opacity": "1",
+         "scale": "1",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": false,
+     "t": 13722,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+         "opacity": "0.749978",
+         "scale": "0.974998",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": false,
+     "t": 13757,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+         "opacity": "0.506649",
+         "scale": "0.950665",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": false,
+     "t": 13779,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+         "opacity": "0.439189",
+         "scale": "0.943919",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": false,
+     "t": 13786,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+         "opacity": "0.310396",
+         "scale": "0.93104",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": false,
+     "t": 13802,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+         "opacity": "0.212929",
+         "scale": "0.921293",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": false,
+     "t": 13818,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+         "opacity": "0.136379",
+         "scale": "0.913638",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": false,
+     "t": 13835,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+         "opacity": "0.084066",
+         "scale": "0.908407",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": false,
+     "t": 13851,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+         "opacity": "0.046844",
+         "scale": "0.904684",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": false,
+     "t": 13867,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+         "opacity": "0.021839",
+         "scale": "0.902184",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": false,
+     "t": 13883,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+         "opacity": "0.006923",
+         "scale": "0.900692",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": false,
+     "t": 13899,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+         "opacity": "0.000339",
+         "scale": "0.900034",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": false,
+     "t": 13915,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 13935,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 13951,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 13964,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 13980,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 13996,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 14012,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 14028,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 14044,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 14060,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 14076,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 14092,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 14108,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 14124,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 14140,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 14156,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 14172,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 14188,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 14204,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 14220,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 14236,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 14252,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 14269,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 14285,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 14301,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+         "opacity": "0.975828",
+         "scale": "0.997583",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": false,
+     "t": 14341,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+         "opacity": "0.197597",
+         "scale": "0.91976",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": false,
+     "t": 14434,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+         "opacity": "0.144161",
+         "scale": "0.914416",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": false,
+     "t": 14446,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+         "opacity": "0.089711",
+         "scale": "0.908971",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": false,
+     "t": 14462,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+         "opacity": "0.050778",
+         "scale": "0.905078",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": false,
+     "t": 14478,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+         "opacity": "0.024375",
+         "scale": "0.902437",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": false,
+     "t": 14494,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+         "opacity": "0.008295",
+         "scale": "0.900829",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": false,
+     "t": 14510,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 14527,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 14545,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     "sameNode": false,
+     "t": 14559,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+         "ending": true,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "0px 0%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": false,
+     "t": 14576,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+         "ending": true,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "0px 3.945286%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": false,
+     "t": 14593,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+         "ending": true,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "0px 11.63678%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": false,
+     "t": 14610,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+         "ending": true,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "0px 19.931311%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": false,
+     "t": 14623,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+         "ending": true,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "0px 31.810513%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": false,
+     "t": 14639,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+         "ending": true,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "0px 43.760098%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": false,
+     "t": 14655,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+         "ending": true,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "0px 54.5368%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": false,
+     "t": 14671,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+         "ending": true,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "0px 63.748638%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": false,
+     "t": 14687,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+         "ending": true,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "0px 71.446602%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": false,
+     "t": 14703,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+         "ending": true,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "0px 77.818192%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": false,
+     "t": 14719,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+         "ending": true,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "0px 83.062607%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": false,
+     "t": 14735,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+         "ending": true,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "0px 87.353912%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": false,
+     "t": 14751,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+         "ending": true,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "0px 91.028908%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": false,
+     "t": 14768,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+         "ending": true,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "0px 93.776527%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": false,
+     "t": 14784,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+         "ending": true,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "0px 95.810684%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": false,
+     "t": 14799,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+         "ending": true,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "0px 97.562538%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": false,
+     "t": 14816,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+         "ending": true,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "0px 98.738045%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": false,
+     "t": 14832,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+         "ending": true,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "0px 99.50708%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": false,
+     "t": 14848,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+         "ending": true,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "0px 99.951103%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": false,
+     "t": 14867,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     ],
+     "phase": "close-0",
+     "sameNode": false,
+     "t": 14882,
+   },
+   Object {
+     "card": Object {
+       "bottom": 92,
+       "height": 36,
+       "left": 64.140625,
+       "right": 317.84375,
+       "top": 56,
+       "width": 253.703125,
+       "x": 64.140625,
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
+     ],
+     "phase": "close-0",
+     "sameNode": false,
+     "t": 14896,
+   },
+ ]
```

# Page snapshot

```yaml
- generic [ref=e1]:
  - main [ref=e4]:
    - heading "Notification integration" [level=1] [ref=e5]
    - status [ref=e6]: dark
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
    - button "Open Dialog" [ref=e30] [cursor=pointer]
    - button "Open Drawer" [ref=e32] [cursor=pointer]
    - button "Open Bottom drawer" [active] [ref=e34] [cursor=pointer]
    - button "Open Retained dialog" [ref=e36] [cursor=pointer]
    - button "Legacy confirm" [ref=e38] [cursor=pointer]
  - generic [ref=e40]: Couldn't save the schedule. revision 12 is stale
  - generic:
    - region "Notifications":
      - button "Couldn't save the schedule" [ref=e41] [cursor=pointer]
```

# Test source

```ts
  38  |     await button(page, `Open ${kind}`).click();
  39  |     await page.waitForFunction(() => window.motionDone);
  40  |     const samples = await page.evaluate(() => window.motionSamples);
  41  |     const shifted = samples.filter(s => Math.abs(s.x - before.x) > 1 || Math.abs(s.y - before.y) > 1);
  42  |     await info.attach('entry-geometry', { body: JSON.stringify({ kind, before, samples, shifted }, null, 2), contentType: 'application/json' });
  43  |     expect(shifted, 'an existing notification should not move with the newly opening modal').toHaveLength(0);
  44  |   });
  45  | }
  46  | 
  47  | test('hover pause releases after a keyboard opened and closed overlay changes portal', async ({ page }, info) => {
  48  |   await page.clock.install({ time: new Date('2026-10-04T00:00:00Z') });
  49  |   await page.clock.pauseAt(new Date('2026-10-04T00:00:01Z'));
  50  |   await button(page, 'Complete session').click();
  51  |   const region = page.locator('.toast-viewport');
  52  |   await region.locator('button[aria-label="Undo completing Fix login redirect"]').hover();
  53  |   await page.clock.runFor(10000);
  54  |   await expect(region).toBeVisible();
  55  |   await button(page, 'Open Dialog').focus();
  56  |   await page.keyboard.press('Enter');
  57  |   await page.clock.runFor(200);
  58  |   await expect(page.getByRole('dialog', { name: 'Workspace editor', exact: true })).toBeVisible();
  59  |   await page.keyboard.press('Escape');
  60  |   await page.clock.runFor(200);
  61  |   await expect(page.getByRole('dialog', { name: 'Workspace editor', exact: true })).not.toBeVisible();
  62  |   await page.mouse.move(0, 0);
  63  |   await page.clock.runFor(6001);
  64  |   const after = await page.locator('.toast-slot:not(.toast-slot--leaving)').count();
  65  |   await info.attach('timer-after-portal', { body: JSON.stringify({ after, releasedAfterMs: 6001 }), contentType: 'application/json' });
  66  |   expect(after).toBe(0);
  67  |   await expectExpired(page, 1);
  68  | });
  69  | 
  70  | 
  71  | test('native hover deadline resumes after portal changes', async ({ page }, info) => {
  72  |   await button(page, 'Complete session').click();
  73  |   const region = page.locator('.toast-viewport');
  74  |   await region.locator('button[aria-label="Undo completing Fix login redirect"]').hover();
  75  |   await button(page, 'Open Dialog').focus();
  76  |   await page.keyboard.press('Enter');
  77  |   await expect(page.getByRole('dialog', { name: 'Workspace editor', exact: true })).toBeVisible();
  78  |   await page.keyboard.press('Escape');
  79  |   await expect(page.getByRole('dialog', { name: 'Workspace editor', exact: true })).not.toBeVisible();
  80  |   await page.mouse.move(0, 0);
  81  |   const releasedAt = Date.now();
  82  |   try { await expect(region).toHaveCount(0, { timeout: 7500 }); }
  83  |   finally {
  84  |     await info.attach('native-timer', {body: JSON.stringify({ elapsedMs:Date.now()-releasedAt, count:await region.count() }), contentType:'application/json'});
  85  |   }
  86  | });
  87  | 
  88  | const region = (page) => page.getByRole('region', { name: 'Notifications', exact: true });
  89  | const attach = (info, name, value) => info.attach(name, { body: JSON.stringify(value, null, 2), contentType: 'application/json' });
  90  | const finishMotion = (page) => page.evaluate(async () => {
  91  |   await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  92  |   await Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {})));
  93  | });
  94  | 
  95  | for (const kind of ['Dialog', 'Drawer', 'Bottom drawer']) {
  96  |   test(`notification card stays fixed through ${kind} entry, nested layers and exit`, async ({ page }, info) => {
  97  |     await page.emulateMedia({ reducedMotion: 'no-preference' });
  98  |     await button(page, 'Error notice').click();
  99  |     await page.mouse.move(0, 0);
  100 |     await finishMotion(page);
  101 |     await page.evaluate(() => {
  102 |       const card = document.querySelector('.toast');
  103 |       window.cardMotion = { before: card.getBoundingClientRect().toJSON(), samples: [], phase: 'before', running: true };
  104 |       const sample = () => {
  105 |         const current = document.querySelector('.toast');
  106 |         const r = current?.getBoundingClientRect();
  107 |         window.cardMotion.samples.push({ phase: window.cardMotion.phase, t: performance.now(), sameNode: current === card,
  108 |           card: r?.toJSON(), opacity: current ? getComputedStyle(current).opacity : null,
  109 |           overlays: [...document.querySelectorAll('.orbit-overlay')].map((el) => {
  110 |             const s = getComputedStyle(el);
  111 |             return { scale: s.scale, translate: s.translate, opacity: s.opacity, ending: el.hasAttribute('data-ending-style') };
  112 |           }) });
  113 |         if (window.cardMotion.running) requestAnimationFrame(sample);
  114 |       };
  115 |       requestAnimationFrame(sample);
  116 |     });
  117 |     const phase = (name) => page.evaluate((value) => { window.cardMotion.phase = value; }, name);
  118 |     await phase('open');
  119 |     await button(page, `Open ${kind}`).click();
  120 |     await finishMotion(page);
  121 |     for (let depth = 1; depth <= 2; depth++) {
  122 |       await phase(`nested-${depth}`);
  123 |       await button(page, 'Nested dialog').click();
  124 |       await finishMotion(page);
  125 |       await expect(region(page)).toBeVisible();
  126 |     }
  127 |     for (let depth = 2; depth >= 0; depth--) {
  128 |       await phase(`close-${depth}`);
  129 |       await page.keyboard.press('Escape');
  130 |       await finishMotion(page);
  131 |       await expect(region(page)).toBeVisible();
  132 |     }
  133 |     const motion = await page.evaluate(() => { window.cardMotion.running = false; return window.cardMotion; });
  134 |     await attach(info, 'continuous-card-motion', motion);
  135 |     expect(motion.samples.length).toBeGreaterThan(20);
  136 |     const shifted = motion.samples.filter((s) => !s.sameNode || !s.card || s.opacity !== '1' ||
  137 |       ['x', 'y', 'width', 'height'].some((key) => Math.abs(s.card[key] - motion.before[key]) > 0.1));
> 138 |     expect(shifted, 'existing card DOM, opacity and geometry stay stable at every sampled frame').toEqual([]);
      |                                                                                                   ^ Error: existing card DOM, opacity and geometry stay stable at every sampled frame
  139 |     // These checks also prove the original popup transitions still run in both directions.
  140 |     for (const name of ['open', 'nested-1', 'nested-2', 'close-2', 'close-1', 'close-0']) {
  141 |       expect(motion.samples.some((s) => s.phase === name && s.overlays.some((o) =>
  142 |         Number(o.opacity) < 1 || (o.translate !== 'none' && o.translate !== '0px') || (o.scale !== 'none' && o.scale !== '1'))), name).toBe(true);
  143 |     }
  144 |     await expect(button(page, `Open ${kind}`)).toBeFocused();
  145 |   });
  146 | }
  147 | 
  148 | test('stationary hover stays paused across nested modal owners then resumes for exactly six seconds', async ({ page }, info) => {
  149 |   await page.clock.install({ time: new Date('2026-10-04T00:00:00Z') });
  150 |   await page.clock.pauseAt(new Date('2026-10-04T00:00:01Z'));
  151 |   await button(page, 'Complete session').click();
  152 |   await region(page).getByRole('button', { name: 'Undo completing Fix login redirect', exact: true }).hover();
  153 |   await page.clock.runFor(10000);
  154 |   await expect(region(page)).toBeVisible();
  155 |   for (const name of ['Open Dialog', 'Nested dialog']) {
  156 |     await button(page, name).focus();
  157 |     await page.keyboard.press('Enter');
  158 |     await page.clock.runFor(10200);
  159 |     await expect(region(page)).toBeVisible();
  160 |   }
  161 |   for (let i = 0; i < 2; i++) {
  162 |     await page.keyboard.press('Escape');
  163 |     await page.clock.runFor(10200);
  164 |     await expect(region(page)).toBeVisible();
  165 |   }
  166 |   await page.mouse.move(0, 0);
  167 |   await page.clock.runFor(5999);
  168 |   await expect(region(page)).toBeVisible();
  169 |   await page.clock.runFor(1);
  170 |   await expectExpired(page);
  171 |   await attach(info, 'stationary-hover', { pausedAcrossFourTransfersMs: 40800, pausedBeforeTransfersMs: 10000, visibleAfterReleaseMs: 5999, expiredAfterReleaseMs: 6000 });
  172 | });
  173 | 
  174 | test('unhovered notifications retain their original deadline through modal owner changes', async ({ page }, info) => {
  175 |   await page.clock.install({ time: new Date('2026-10-04T00:00:00Z') });
  176 |   await page.clock.pauseAt(new Date('2026-10-04T00:00:01Z'));
  177 |   await button(page, 'Complete session').click();
  178 |   await page.mouse.move(0, 0);
  179 |   await page.clock.runFor(2000);
  180 |   await button(page, 'Open Drawer').focus();
  181 |   await page.keyboard.press('Enter');
  182 |   await page.clock.runFor(200);
  183 |   await page.keyboard.press('Escape');
  184 |   await page.clock.runFor(3799);
  185 |   await expect(region(page)).toBeVisible();
  186 |   await page.clock.runFor(1);
  187 |   await expectExpired(page);
  188 |   await attach(info, 'unchanged-deadline', { visibleAtTotalMs: 5999, expiredAtTotalMs: 6000 });
  189 | });
  190 | 
  191 | for (const [kind, trigger] of [['Dialog', 'Open Dialog'], ['Drawer', 'Open Drawer'], ['Bottom drawer', 'Open Bottom drawer'], ['Confirmation', 'Confirm save']]) {
  192 |   test(`notification pixels stay intact through ${kind} opening and closing`, async ({ page }, info) => {
  193 |     await page.emulateMedia({ reducedMotion: 'no-preference' });
  194 |     await button(page, 'Error notice').click();
  195 |     await page.mouse.move(0, 0);
  196 |     await finishMotion(page);
  197 |     await info.attach('before-motion', { body: await region(page).screenshot({ animations: 'allow' }), contentType: 'image/png' });
  198 |     await button(page, trigger).click();
  199 |     for (const phase of ['opening', 'closing']) {
  200 |       if (phase === 'closing') await page.keyboard.press('Escape');
  201 |       const frozen = await page.evaluate(async () => {
  202 |         await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  203 |         const popup = [...document.querySelectorAll('.orbit-overlay')].find((el) => el.getClientRects().length);
  204 |         const popupAnimationCount = popup?.getAnimations().length ?? 0;
  205 |         window.frozenPopupAnimations = document.getAnimations().filter((a) =>
  206 |           a.effect?.target?.matches?.('.orbit-overlay, .orbit-overlay-backdrop'));
  207 |         for (const animation of window.frozenPopupAnimations) {
  208 |           animation.pause();
  209 |           animation.currentTime = Number(animation.effect.getTiming().duration) / 2;
  210 |         }
  211 |         const s = popup && getComputedStyle(popup);
  212 |         return { count: popupAnimationCount, scale: s?.scale, translate: s?.translate, opacity: s?.opacity };
  213 |       });
  214 |       if (kind === 'Confirmation') {
  215 |         // The original holder mounts already open, then unmounts on resolution:
  216 |         // it has no popup entry/exit transition in either baseline browser.
  217 |         await expect(page.locator('.orbit-confirm')).toHaveCount(phase === 'opening' ? 1 : 0);
  218 |         expect(frozen.count).toBe(0);
  219 |       } else {
  220 |         expect(frozen.count, 'the real popup animation must exist; it is paused only for the screenshot').toBeGreaterThan(0);
  221 |       }
  222 |       await page.mouse.move(0, 0);
  223 |       // Only the popup/backdrop are frozen. Let button hover colors settle so
  224 |       // screenshots compare the same moment instead of an unrelated hover fade.
  225 |       await page.evaluate(async () => {
  226 |         const frozen = new Set(window.frozenPopupAnimations);
  227 |         await Promise.all(document.getAnimations().filter((a) => !frozen.has(a) &&
  228 |           a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {})));
  229 |       });
  230 |       await info.attach(`${phase}-page`, { body: await page.screenshot({ animations: 'allow' }), contentType: 'image/png' });
  231 |       await info.attach(`${phase}-notification`, { body: await region(page).screenshot({ animations: 'allow' }), contentType: 'image/png' });
  232 |       await attach(info, `${phase}-animation`, frozen);
  233 |       await page.evaluate(() => window.frozenPopupAnimations.forEach((a) => a.play()));
  234 |       await finishMotion(page);
  235 |     }
  236 |     await expect(region(page)).toBeVisible();
  237 |   });
  238 | }
```