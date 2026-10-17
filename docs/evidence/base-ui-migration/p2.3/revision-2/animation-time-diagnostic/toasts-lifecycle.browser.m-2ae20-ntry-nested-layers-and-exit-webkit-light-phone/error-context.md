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
+ Received  + 2420

- Array []
+ Array [
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
+         "opacity": "0",
+         "scale": "0.9",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1411,
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
+         "opacity": "0",
+         "scale": "0.9",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1424,
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
+         "opacity": "0.155613",
+         "scale": "0.915561",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1450,
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
+         "opacity": "0.503401",
+         "scale": "0.95034",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1482,
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
+         "opacity": "0.668038",
+         "scale": "0.966804",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1501,
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
+         "opacity": "0.689604",
+         "scale": "0.96896",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1503,
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
+         "opacity": "0.787071",
+         "scale": "0.978707",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1520,
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
+         "opacity": "0.859767",
+         "scale": "0.985977",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1536,
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
+         "opacity": "0.913141",
+         "scale": "0.991314",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1552,
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
+         "opacity": "0.951213",
+         "scale": "0.995121",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1568,
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
+         "opacity": "0.976913",
+         "scale": "0.997691",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1584,
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
+         "opacity": "0.992408",
+         "scale": "0.999241",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1600,
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
+         "opacity": "0.999879",
+         "scale": "0.999988",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1620,
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
+     "t": 1633,
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
+     "t": 1650,
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
+     "t": 1664,
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
+     "t": 1680,
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
+     "t": 1681,
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
+         "opacity": "0",
+         "scale": "0.9",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1699,
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
+         "opacity": "0",
+         "scale": "0.9",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1716,
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
+         "opacity": "0.261224",
+         "scale": "0.926122",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1751,
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
+         "opacity": "0.604795",
+         "scale": "0.960479",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1785,
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
+         "opacity": "0.668038",
+         "scale": "0.966804",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1793,
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
+         "opacity": "0.770873",
+         "scale": "0.977087",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1809,
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
+         "opacity": "0.847752",
+         "scale": "0.984775",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1825,
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
+         "opacity": "0.929034",
+         "scale": "0.992903",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1850,
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
+         "opacity": "0.945093",
+         "scale": "0.994509",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1857,
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
+         "opacity": "0.972929",
+         "scale": "0.997293",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1873,
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
+         "opacity": "0.990199",
+         "scale": "0.99902",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1889,
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
+         "opacity": "0.998625",
+         "scale": "0.999862",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1905,
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
+     "t": 1922,
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
+         "opacity": "1",
+         "scale": "1",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 1948,
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
+         "opacity": "0.681895",
+         "scale": "0.968189",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 1990,
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
+         "opacity": "0.296635",
+         "scale": "0.929664",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2031,
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
+         "opacity": "0.183091",
+         "scale": "0.918309",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2051,
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
+         "opacity": "0.104893",
+         "scale": "0.910489",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2070,
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
+         "opacity": "0.084066",
+         "scale": "0.908407",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2078,
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
+         "opacity": "0.048787",
+         "scale": "0.904879",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2092,
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
+         "opacity": "0.024375",
+         "scale": "0.902437",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2108,
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
+         "opacity": "0.007592",
+         "scale": "0.900759",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2125,
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
+         "opacity": "0.000668",
+         "scale": "0.900067",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2141,
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
+     "t": 2161,
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
+         "opacity": "1",
+         "scale": "1",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2188,
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
+         "opacity": "0.727494",
+         "scale": "0.972749",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2224,
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
+         "opacity": "0.370483",
+         "scale": "0.937048",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2260,
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
+         "opacity": "0.296635",
+         "scale": "0.929664",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2270,
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
+         "opacity": "0.202613",
+         "scale": "0.920261",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2286,
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
+         "opacity": "0.128892",
+         "scale": "0.912889",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2303,
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
+         "opacity": "0.073474",
+         "scale": "0.907347",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2321,
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
+         "opacity": "0.0431",
+         "scale": "0.90431",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2335,
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
+         "opacity": "0.01946",
+         "scale": "0.901946",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2351,
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
+         "opacity": "0.005684",
+         "scale": "0.900568",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2367,
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
+         "opacity": "0.000216",
+         "scale": "0.900022",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2383,
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
+     "t": 2401,
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
+         "ending": true,
+         "opacity": "1",
+         "scale": "1",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2426,
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
+         "ending": true,
+         "opacity": "0.872087",
+         "scale": "0.987209",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2449,
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
+         "ending": true,
+         "opacity": "0.148166",
+         "scale": "0.914817",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2536,
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
+         "ending": true,
+         "opacity": "0.114771",
+         "scale": "0.911477",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2544,
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
+         "ending": true,
+         "opacity": "0.070966",
+         "scale": "0.907097",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2560,
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
+         "ending": true,
+         "opacity": "0.03454",
+         "scale": "0.903454",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2578,
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
+         "ending": true,
+         "opacity": "0.016178",
+         "scale": "0.901618",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2592,
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
+         "ending": true,
+         "opacity": "0.003145",
+         "scale": "0.900314",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2610,
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
+         "ending": true,
+         "opacity": "0.000013",
+         "scale": "0.900001",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2625,
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
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2645,
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
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2684,
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
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2690,
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