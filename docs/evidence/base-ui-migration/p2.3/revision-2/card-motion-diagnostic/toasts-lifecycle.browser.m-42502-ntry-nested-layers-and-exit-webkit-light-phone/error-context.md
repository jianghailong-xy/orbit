# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: toasts-lifecycle.browser.mjs >> notification card stays fixed through Bottom drawer entry, nested layers and exit
- Location: src/web/ui-migration/toasts-lifecycle.browser.mjs:94:3

# Error details

```
Error: existing card DOM, opacity and geometry stay stable at every sampled frame

expect(received).toEqual(expected) // deep equality

- Expected  -    1
+ Received  + 2570

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
+         "opacity": "1",
+         "scale": "none",
+         "translate": "0px 100%",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 907,
+   },
+   Object {
+     "card": Object {
+       "bottom": 193.00140380859375,
+       "height": 144,
+       "left": 16,
+       "right": 366,
+       "top": 49.00140380859375,
+       "width": 350,
+       "x": 16,
+       "y": 49.00140380859375,
+     },
+     "opacity": "0.416784",
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
+         "translate": "0px 100%",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 925,
+   },
+   Object {
+     "card": Object {
+       "bottom": 198.80278396606445,
+       "height": 144,
+       "left": 16,
+       "right": 366,
+       "top": 54.80278396606445,
+       "width": 350,
+       "x": 16,
+       "y": 54.80278396606445,
+     },
+     "opacity": "0.900232",
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
+         "translate": "0px 75.739273%",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 977,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.64248275756836,
+       "height": 144,
+       "left": 16,
+       "right": 366,
+       "top": 55.64248275756836,
+       "width": 350,
+       "x": 16,
+       "y": 55.64248275756836,
+     },
+     "opacity": "0.970207",
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
+         "translate": "0px 49.327953%",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 1013,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.7570915222168,
+       "height": 144,
+       "left": 16,
+       "right": 366,
+       "top": 55.7570915222168,
+       "width": 350,
+       "x": 16,
+       "y": 55.7570915222168,
+     },
+     "opacity": "0.979758",
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
+         "translate": "0px 43.011124%",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 1023,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.8694076538086,
+       "height": 144,
+       "left": 16,
+       "right": 366,
+       "top": 55.869407653808594,
+       "width": 350,
+       "x": 16,
+       "y": 55.869407653808594,
+     },
+     "opacity": "0.989117",
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
+         "translate": "0px 35.209637%",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 1037,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.94396209716797,
+       "height": 144,
+       "left": 16,
+       "right": 366,
+       "top": 55.94396209716797,
+       "width": 350,
+       "x": 16,
+       "y": 55.94396209716797,
+     },
+     "opacity": "0.99533",
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
+         "translate": "0px 28.118456%",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 1052,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.9859619140625,
+       "height": 144,
+       "left": 16,
+       "right": 366,
+       "top": 55.9859619140625,
+       "width": 350,
+       "x": 16,
+       "y": 55.9859619140625,
+     },
+     "opacity": "0.99883",
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
+         "translate": "0px 21.822971%",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 1068,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.9998435974121,
+       "height": 144,
+       "left": 16,
+       "right": 366,
+       "top": 55.99984359741211,
+       "width": 350,
+       "x": 16,
+       "y": 55.99984359741211,
+     },
+     "opacity": "0.999987",
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
+         "translate": "0px 16.642902%",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 1084,
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
+     "t": 1287,
+   },
+   Object {
+     "card": Object {
+       "bottom": 195.26527404785156,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 51.26527404785156,
+       "width": 358,
+       "x": 16,
+       "y": 51.26527404785156,
+     },
+     "opacity": "0.605439",
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
+     "t": 1316,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.48947143554688,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.489471435546875,
+       "width": 358,
+       "x": 16,
+       "y": 55.489471435546875,
+     },
+     "opacity": "0.957456",
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
+         "opacity": "0.587622",
+         "scale": "0.958762",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1383,
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
+         "ending": false,
+         "opacity": "0.797387",
+         "scale": "0.979739",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1414,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.94396209716797,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.94396209716797,
+       "width": 358,
+       "x": 16,
+       "y": 55.94396209716797,
+     },
+     "opacity": "0.99533",
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
+         "opacity": "0.874743",
+         "scale": "0.987474",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1432,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.96067810058594,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.96067810058594,
+       "width": 358,
+       "x": 16,
+       "y": 55.96067810058594,
+     },
+     "opacity": "0.996723",
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
+         "opacity": "0.891881",
+         "scale": "0.989188",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1437,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.99291610717773,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.992916107177734,
+       "width": 358,
+       "x": 16,
+       "y": 55.992916107177734,
+     },
+     "opacity": "0.99941",
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
+         "opacity": "0.936231",
+         "scale": "0.993623",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1453,
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
+         "opacity": "0.968574",
+         "scale": "0.996857",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1470,
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
+         "opacity": "0.98677",
+         "scale": "0.998677",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1485,
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
+         "opacity": "0.99833",
+         "scale": "0.999833",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1504,
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
+     "t": 1518,
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
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1549,
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
+     "t": 1565,
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
+     "t": 1566,
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
+     "t": 1591,
+   },
+   Object {
+     "card": Object {
+       "bottom": 195.43298721313477,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 51.432987213134766,
+       "width": 358,
+       "x": 16,
+       "y": 51.432987213134766,
+     },
+     "opacity": "0.619416",
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
+     "t": 1621,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.04292678833008,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.04292678833008,
+       "width": 358,
+       "x": 16,
+       "y": 55.04292678833008,
+     },
+     "opacity": "0.920244",
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
+         "opacity": "0.386261",
+         "scale": "0.938626",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1668,
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
+         "ending": false,
+         "opacity": "0.753765",
+         "scale": "0.975377",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1711,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.81122207641602,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.811222076416016,
+       "width": 358,
+       "x": 16,
+       "y": 55.811222076416016,
+     },
+     "opacity": "0.984268",
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
+         "opacity": "0.765274",
+         "scale": "0.976527",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1713,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.94017791748047,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.94017791748047,
+       "width": 358,
+       "x": 16,
+       "y": 55.94017791748047,
+     },
+     "opacity": "0.995015",
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
+         "opacity": "0.867401",
+         "scale": "0.98674",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1735,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.98905563354492,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.98905563354492,
+       "width": 358,
+       "x": 16,
+       "y": 55.98905563354492,
+     },
+     "opacity": "0.999088",
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
+         "opacity": "0.926526",
+         "scale": "0.992653",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1754,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.99589157104492,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.99589157104492,
+       "width": 358,
+       "x": 16,
+       "y": 55.99589157104492,
+     },
+     "opacity": "0.999658",
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
+         "opacity": "0.940765",
+         "scale": "0.994076",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1760,
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
+         "opacity": "0.968574",
+         "scale": "0.996857",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1775,
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
+         "opacity": "0.98768",
+         "scale": "0.998768",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1791,
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
+         "opacity": "0.997653",
+         "scale": "0.999765",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1807,
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
+     "t": 1824,
+   },
+   Object {
+     "card": Object {
+       "bottom": 190.96295547485352,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 46.962955474853516,
+       "width": 358,
+       "x": 16,
+       "y": 46.962955474853516,
+     },
+     "opacity": "0.246913",
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
+         "opacity": "0.962222",
+         "scale": "0.996222",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 1862,
+   },
+   Object {
+     "card": Object {
+       "bottom": 198.29779052734375,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 54.29779052734375,
+       "width": 358,
+       "x": 16,
+       "y": 54.29779052734375,
+     },
+     "opacity": "0.858149",
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
+         "opacity": "0.486685",
+         "scale": "0.948668",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 1911,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.15876007080078,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.15876007080078,
+       "width": 358,
+       "x": 16,
+       "y": 55.15876007080078,
+     },
+     "opacity": "0.929897",
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
+         "opacity": "0.303455",
+         "scale": "0.930346",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 1933,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.23698806762695,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.23698806762695,
+       "width": 358,
+       "x": 16,
+       "y": 55.23698806762695,
+     },
+     "opacity": "0.936416",
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
+         "opacity": "0.283353",
+         "scale": "0.928335",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 1936,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.55598831176758,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.55598831176758,
+       "width": 358,
+       "x": 16,
+       "y": 55.55598831176758,
+     },
+     "opacity": "0.962999",
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
+         "opacity": "0.192672",
+         "scale": "0.919267",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 1952,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.7570915222168,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.7570915222168,
+       "width": 358,
+       "x": 16,
+       "y": 55.7570915222168,
+     },
+     "opacity": "0.979758",
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
+         "opacity": "0.125257",
+         "scale": "0.912526",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 1968,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.88175201416016,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.881752014160156,
+       "width": 358,
+       "x": 16,
+       "y": 55.881752014160156,
+     },
+     "opacity": "0.990635",
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
+         "opacity": "0.073474",
+         "scale": "0.907347",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 1985,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.9576187133789,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.957618713378906,
+       "width": 358,
+       "x": 16,
+       "y": 55.957618713378906,
+     },
+     "opacity": "0.996468",
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
+         "opacity": "0.039541",
+         "scale": "0.903954",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2001,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.99589157104492,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.99589157104492,
+       "width": 358,
+       "x": 16,
+       "y": 55.99589157104492,
+     },
+     "opacity": "0.999658",
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
+         "opacity": "0.01323",
+         "scale": "0.901323",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2021,
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
+         "opacity": "0.004573",
+         "scale": "0.900457",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2033,
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
+         "opacity": "0.000054",
+         "scale": "0.900005",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2049,
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
+     "t": 2068,
+   },
+   Object {
+     "card": Object {
+       "bottom": 189.07484436035156,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 45.07484436035156,
+       "width": 358,
+       "x": 16,
+       "y": 45.07484436035156,
+     },
+     "opacity": "0.08957",
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
+         "opacity": "0.990018",
+         "scale": "0.999002",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2093,
+   },
+   Object {
+     "card": Object {
+       "bottom": 197.11054611206055,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 53.11054611206055,
+       "width": 358,
+       "x": 16,
+       "y": 53.11054611206055,
+     },
+     "opacity": "0.759212",
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
+         "opacity": "0.659033",
+         "scale": "0.965903",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2133,
+   },
+   Object {
+     "card": Object {
+       "bottom": 198.59570693969727,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 54.595706939697266,
+       "width": 358,
+       "x": 16,
+       "y": 54.595706939697266,
+     },
+     "opacity": "0.882976",
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
+         "opacity": "0.430111",
+         "scale": "0.943011",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2155,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.26155853271484,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.261558532714844,
+       "width": 358,
+       "x": 16,
+       "y": 55.261558532714844,
+     },
+     "opacity": "0.938463",
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
+         "opacity": "0.276886",
+         "scale": "0.927689",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2175,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.4532356262207,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.4532356262207,
+       "width": 358,
+       "x": 16,
+       "y": 55.4532356262207,
+     },
+     "opacity": "0.954436",
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
+         "opacity": "0.223629",
+         "scale": "0.922363",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2184,
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
+     "opacity": "0.967941",
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
+         "opacity": "0.173861",
+         "scale": "0.917386",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2194,
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
+         "ending": true,
+         "opacity": "0.104893",
+         "scale": "0.910489",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2211,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.8987808227539,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.898780822753906,
+       "width": 358,
+       "x": 16,
+       "y": 55.898780822753906,
+     },
+     "opacity": "0.991565",
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
+         "opacity": "0.066115",
+         "scale": "0.906611",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2225,
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
+         "ending": true,
+         "opacity": "0.03454",
+         "scale": "0.903454",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2242,
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
+         "ending": true,
+         "opacity": "0.014176",
+         "scale": "0.901418",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2258,
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
+         "opacity": "0.003145",
+         "scale": "0.900314",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2274,
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
+     "t": 2293,
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
+         "ending": true,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "0px 0%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2313,
+   },
+   Object {
+     "card": Object {
+       "bottom": 194.7238540649414,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 50.723854064941406,
+       "width": 358,
+       "x": 16,
+       "y": 50.723854064941406,
+     },
+     "opacity": "0.575898",
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
+         "translate": "0px 8.479707%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2341,
+   },
+   Object {
+     "card": Object {
+       "bottom": 197.79096221923828,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 53.79096221923828,
+       "width": 358,
+       "x": 16,
+       "y": 53.79096221923828,
+     },
+     "opacity": "0.815914",
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
+         "translate": "0px 23.524084%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2365,
+   },
+   Object {
+     "card": Object {
+       "bottom": 198.0623664855957,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 54.0623664855957,
+       "width": 358,
+       "x": 16,
+       "y": 54.0623664855957,
+     },
+     "opacity": "0.843696",
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
+         "translate": "0px 27.250641%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2370,
+   },
+   Object {
+     "card": Object {
+       "bottom": 198.87680435180664,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 54.87680435180664,
+       "width": 358,
+       "x": 16,
+       "y": 54.87680435180664,
+     },
+     "opacity": "0.9064",
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
+         "translate": "0px 39.371357%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2386,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.33109664916992,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.33109664916992,
+       "width": 358,
+       "x": 16,
+       "y": 55.33109664916992,
+     },
+     "opacity": "0.944258",
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
+         "translate": "0px 50.672047%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2402,
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
+     "opacity": "0.967941",
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
+         "translate": "0px 60.479469%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2418,
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
+         "ending": true,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "0px 68.726334%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2434,
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
+         "ending": true,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "0px 75.571251%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2450,
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
+         "ending": true,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "0px 81.216309%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2466,
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
+         "ending": true,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "0px 85.846619%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2482,
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
    - button "Open Dialog" [ref=e30] [cursor=pointer]
    - button "Open Drawer" [ref=e32] [cursor=pointer]
    - button "Open Bottom drawer" [active] [ref=e34] [cursor=pointer]
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