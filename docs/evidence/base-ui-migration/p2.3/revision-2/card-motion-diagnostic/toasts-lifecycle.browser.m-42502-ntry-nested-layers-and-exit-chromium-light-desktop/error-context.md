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
+ Received  + 2408

- Array []
+ Array [
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 920,
+       "right": 1280,
+       "top": 16,
+       "width": 360,
+       "x": 920,
+       "y": 16,
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
+     "t": 1307.7000000178814,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 920,
+       "right": 1280,
+       "top": 16,
+       "width": 360,
+       "x": 920,
+       "y": 16,
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
+     "t": 1309.2000000178814,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 914.094482421875,
+       "right": 1274.094482421875,
+       "top": 16,
+       "width": 360,
+       "x": 914.094482421875,
+       "y": 16,
+     },
+     "opacity": "0.369096",
+     "overlays": Array [
+       Object {
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
+     "t": 1326.2000000178814,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 909.5946655273438,
+       "right": 1269.5947265625,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 909.5946655273438,
+       "y": 16,
+     },
+     "opacity": "0.650333",
+     "overlays": Array [
+       Object {
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
+     "t": 1342.2000000178814,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 907.1516723632812,
+       "right": 1267.151611328125,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 907.1516723632812,
+       "y": 16,
+     },
+     "opacity": "0.803021",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "0px 96.1806%",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 1359,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 905.83349609375,
+       "right": 1265.83349609375,
+       "top": 16,
+       "width": 360,
+       "x": 905.83349609375,
+       "y": 16,
+     },
+     "opacity": "0.885405",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "0px 88.7416%",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 1375.7000000178814,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 905.0733032226562,
+       "right": 1265.0733642578125,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 905.0733032226562,
+       "y": 16,
+     },
+     "opacity": "0.932917",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "0px 77.9146%",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 1392.4000000059605,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 904.6141967773438,
+       "right": 1264.6141357421875,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 904.6141967773438,
+       "y": 16,
+     },
+     "opacity": "0.961614",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "0px 65.4281%",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 1408.9000000059605,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 904.3284301757812,
+       "right": 1264.328369140625,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 904.3284301757812,
+       "y": 16,
+     },
+     "opacity": "0.979474",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "0px 53.1824%",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 1425.6000000238419,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 904.1556396484375,
+       "right": 1264.1556396484375,
+       "top": 16,
+       "width": 360,
+       "x": 904.1556396484375,
+       "y": 16,
+     },
+     "opacity": "0.990273",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "0px 42.4584%",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 1442.300000011921,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 904.0562744140625,
+       "right": 1264.0562744140625,
+       "top": 16,
+       "width": 360,
+       "x": 904.0562744140625,
+       "y": 16,
+     },
+     "opacity": "0.996483",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "0px 33.3317%",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 1458.800000011921,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 904.0099487304688,
+       "right": 1264.010009765625,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 904.0099487304688,
+       "y": 16,
+     },
+     "opacity": "0.999377",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "0px 25.8875%",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 1475.6000000238419,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 920,
+       "right": 1280,
+       "top": 16,
+       "width": 360,
+       "x": 920,
+       "y": 16,
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
+     "t": 1703.300000011921,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 914.1004638671875,
+       "right": 1274.1004638671875,
+       "top": 16,
+       "width": 360,
+       "x": 914.1004638671875,
+       "y": 16,
+     },
+     "opacity": "0.368722",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
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
+     "t": 1716.9000000059605,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 909.5982666015625,
+       "right": 1269.5982666015625,
+       "top": 16,
+       "width": 360,
+       "x": 909.5982666015625,
+       "y": 16,
+     },
+     "opacity": "0.650107",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.0708483",
+         "scale": "0.907085",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1733.2000000178814,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 907.153564453125,
+       "right": 1267.153564453125,
+       "top": 16,
+       "width": 360,
+       "x": 907.153564453125,
+       "y": 16,
+     },
+     "opacity": "0.802903",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.22002",
+         "scale": "0.922002",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1745.300000011921,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 905.8345947265625,
+       "right": 1265.8345947265625,
+       "top": 16,
+       "width": 360,
+       "x": 905.8345947265625,
+       "y": 16,
+     },
+     "opacity": "0.885339",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.408212",
+         "scale": "0.940821",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1759,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 905.073974609375,
+       "right": 1265.073974609375,
+       "top": 16,
+       "width": 360,
+       "x": 905.073974609375,
+       "y": 16,
+     },
+     "opacity": "0.932878",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.575919",
+         "scale": "0.957592",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1776.6000000238419,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 904.6124267578125,
+       "right": 1264.6124267578125,
+       "top": 16,
+       "width": 360,
+       "x": 904.6124267578125,
+       "y": 16,
+     },
+     "opacity": "0.961725",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.705878",
+         "scale": "0.970588",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1792.4000000059605,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 904.3286743164062,
+       "right": 1264.32861328125,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 904.3286743164062,
+       "y": 16,
+     },
+     "opacity": "0.979459",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.802269",
+         "scale": "0.980227",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1808.9000000059605,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 904.1549682617188,
+       "right": 1264.155029296875,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 904.1549682617188,
+       "y": 16,
+     },
+     "opacity": "0.990314",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.873562",
+         "scale": "0.987356",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1825.5,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 904.0563354492188,
+       "right": 1264.056396484375,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 904.0563354492188,
+       "y": 16,
+     },
+     "opacity": "0.996478",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.924926",
+         "scale": "0.992493",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1842.300000011921,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 904.0098266601562,
+       "right": 1264.0098876953125,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 904.0098266601562,
+       "y": 16,
+     },
+     "opacity": "0.999385",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.960585",
+         "scale": "0.996059",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1858.9000000059605,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 920,
+       "right": 1280,
+       "top": 16,
+       "width": 360,
+       "x": 920,
+       "y": 16,
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
+     "t": 1981,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 914.1077880859375,
+       "right": 1274.1077880859375,
+       "top": 16,
+       "width": 360,
+       "x": 914.1077880859375,
+       "y": 16,
+     },
+     "opacity": "0.368264",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
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
+     "t": 1994.1000000238419,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 909.6027221679688,
+       "right": 1269.6026611328125,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 909.6027221679688,
+       "y": 16,
+     },
+     "opacity": "0.649831",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.0707011",
+         "scale": "0.90707",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 2009,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 907.1558837890625,
+       "right": 1267.1558837890625,
+       "top": 16,
+       "width": 360,
+       "x": 907.1558837890625,
+       "y": 16,
+     },
+     "opacity": "0.802758",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.219782",
+         "scale": "0.921978",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 2025.9000000059605,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 905.8358764648438,
+       "right": 1265.8358154296875,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 905.8358764648438,
+       "y": 16,
+     },
+     "opacity": "0.885259",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.40797",
+         "scale": "0.940797",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 2042.300000011921,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 905.07470703125,
+       "right": 1265.07470703125,
+       "top": 16,
+       "width": 360,
+       "x": 905.07470703125,
+       "y": 16,
+     },
+     "opacity": "0.93283",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.575723",
+         "scale": "0.957572",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 2061.100000023842,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 904.6128540039062,
+       "right": 1264.6129150390625,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 904.6128540039062,
+       "y": 16,
+     },
+     "opacity": "0.961695",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.70573",
+         "scale": "0.970573",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 2075.600000023842,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 904.32763671875,
+       "right": 1264.32763671875,
+       "top": 16,
+       "width": 360,
+       "x": 904.32763671875,
+       "y": 16,
+     },
+     "opacity": "0.979524",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.802657",
+         "scale": "0.980266",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 2092.300000011921,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 904.1551513671875,
+       "right": 1264.1551513671875,
+       "top": 16,
+       "width": 360,
+       "x": 904.1551513671875,
+       "y": 16,
+     },
+     "opacity": "0.990303",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.873482",
+         "scale": "0.987348",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 2108.9000000059605,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 904.0564575195312,
+       "right": 1264.056396484375,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 904.0564575195312,
+       "y": 16,
+     },
+     "opacity": "0.996473",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.924869",
+         "scale": "0.992487",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 2125.7000000178814,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 904.010009765625,
+       "right": 1264.010009765625,
+       "top": 16,
+       "width": 360,
+       "x": 904.010009765625,
+       "y": 16,
+     },
+     "opacity": "0.999373",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.960374",
+         "scale": "0.996037",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 2142.600000023842,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 920,
+       "right": 1280,
+       "top": 16,
+       "width": 360,
+       "x": 920,
+       "y": 16,
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
+     "t": 2236.100000023842,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 914.0711669921875,
+       "right": 1274.0711669921875,
+       "top": 16,
+       "width": 360,
+       "x": 914.0711669921875,
+       "y": 16,
+     },
+     "opacity": "0.370551",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+         "opacity": "0.92879",
+         "scale": "0.992879",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2248.9000000059605,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 909.5806884765625,
+       "right": 1269.5806884765625,
+       "top": 16,
+       "width": 360,
+       "x": 909.5806884765625,
+       "y": 16,
+     },
+     "opacity": "0.651209",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+         "opacity": "0.778311",
+         "scale": "0.977831",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2260.9000000059605,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 907.1548461914062,
+       "right": 1267.15478515625,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 907.1548461914062,
+       "y": 16,
+     },
+     "opacity": "0.802824",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+         "opacity": "0.592296",
+         "scale": "0.95923",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2276.600000023842,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 905.8294067382812,
+       "right": 1265.829345703125,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 905.8294067382812,
+       "y": 16,
+     },
+     "opacity": "0.885661",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+         "opacity": "0.4236",
+         "scale": "0.94236",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2292.300000011921,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 905.0743408203125,
+       "right": 1265.0743408203125,
+       "top": 16,
+       "width": 360,
+       "x": 905.0743408203125,
+       "y": 16,
+     },
+     "opacity": "0.932852",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+         "opacity": "0.294431",
+         "scale": "0.929443",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2309,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 904.6126708984375,
+       "right": 1264.6126708984375,
+       "top": 16,
+       "width": 360,
+       "x": 904.6126708984375,
+       "y": 16,
+     },
+     "opacity": "0.961709",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+         "opacity": "0.197462",
+         "scale": "0.919746",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2325.600000023842,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 904.3287963867188,
+       "right": 1264.328857421875,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 904.3287963867188,
+       "y": 16,
+     },
+     "opacity": "0.979449",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+         "opacity": "0.126605",
+         "scale": "0.91266",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2342.600000023842,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 904.1550903320312,
+       "right": 1264.155029296875,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 904.1550903320312,
+       "y": 16,
+     },
+     "opacity": "0.990308",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+         "opacity": "0.0751923",
+         "scale": "0.907519",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2358.9000000059605,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 904.056396484375,
+       "right": 1264.056396484375,
+       "top": 16,
+       "width": 360,
+       "x": 904.056396484375,
+       "y": 16,
+     },
+     "opacity": "0.996475",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+         "opacity": "0.0394942",
+         "scale": "0.903949",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2375.600000023842,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 904.0098876953125,
+       "right": 1264.0098876953125,
+       "top": 16,
+       "width": 360,
+       "x": 904.0098876953125,
+       "y": 16,
+     },
+     "opacity": "0.999384",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+         "opacity": "0.0164626",
+         "scale": "0.901646",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2392.300000011921,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 920,
+       "right": 1280,
+       "top": 16,
+       "width": 360,
+       "x": 920,
+       "y": 16,
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
+         "ending": true,
+         "opacity": "1",
+         "scale": "1",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2455.4000000059605,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 914.0904541015625,
+       "right": 1274.0904541015625,
+       "top": 16,
+       "width": 360,
+       "x": 914.0904541015625,
+       "y": 16,
+     },
+     "opacity": "0.369346",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+         "opacity": "0.929179",
+         "scale": "0.992918",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2469.2000000178814,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 909.59228515625,
+       "right": 1269.59228515625,
+       "top": 16,
+       "width": 360,
+       "x": 909.59228515625,
+       "y": 16,
+     },
+     "opacity": "0.650483",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+         "opacity": "0.77894",
+         "scale": "0.977894",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2482.2000000178814,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 907.150390625,
+       "right": 1267.150390625,
+       "top": 16,
+       "width": 360,
+       "x": 907.150390625,
+       "y": 16,
+     },
+     "opacity": "0.803099",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+         "opacity": "0.591832",
+         "scale": "0.959183",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2492.600000023842,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 905.8328247070312,
+       "right": 1265.832763671875,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 905.8328247070312,
+       "y": 16,
+     },
+     "opacity": "0.885449",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+         "opacity": "0.424117",
+         "scale": "0.942412",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2509,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 905.0728759765625,
+       "right": 1265.0728759765625,
+       "top": 16,
+       "width": 360,
+       "x": 905.0728759765625,
+       "y": 16,
+     },
+     "opacity": "0.932943",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+         "opacity": "0.294149",
+         "scale": "0.929415",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2525.600000023842,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 904.6117553710938,
+       "right": 1264.61181640625,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 904.6117553710938,
+       "y": 16,
+     },
+     "opacity": "0.961765",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+         "opacity": "0.197254",
+         "scale": "0.919725",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2542.100000023842,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 904.3282470703125,
+       "right": 1264.3282470703125,
+       "top": 16,
+       "width": 360,
+       "x": 904.3282470703125,
+       "y": 16,
+     },
+     "opacity": "0.979484",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+         "opacity": "0.126452",
+         "scale": "0.912645",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2559,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 904.1547241210938,
+       "right": 1264.15478515625,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 904.1547241210938,
+       "y": 16,
+     },
+     "opacity": "0.990328",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+         "opacity": "0.0750843",
+         "scale": "0.907508",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2575.5,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 904.0562133789062,
+       "right": 1264.05615234375,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 904.0562133789062,
+       "y": 16,
+     },
+     "opacity": "0.996486",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+         "opacity": "0.0394215",
+         "scale": "0.903942",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2592.2000000178814,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 904.0099487304688,
+       "right": 1264.010009765625,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 904.0099487304688,
+       "y": 16,
+     },
+     "opacity": "0.999378",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+         "opacity": "0.0165234",
+         "scale": "0.901652",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2609,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 920,
+       "right": 1280,
+       "top": 16,
+       "width": 360,
+       "x": 920,
+       "y": 16,
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
+     "t": 2694.800000011921,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 914.087158203125,
+       "right": 1274.087158203125,
+       "top": 16,
+       "width": 360,
+       "x": 914.087158203125,
+       "y": 16,
+     },
+     "opacity": "0.369553",
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
+         "translate": "0px 3.8374%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2709.300000011921,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 909.6103515625,
+       "right": 1269.6103515625,
+       "top": 16,
+       "width": 360,
+       "x": 909.6103515625,
+       "y": 16,
+     },
+     "opacity": "0.649354",
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
+         "translate": "0px 11.2328%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2726,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 907.1493530273438,
+       "right": 1267.1494140625,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 907.1493530273438,
+       "y": 16,
+     },
+     "opacity": "0.803165",
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
+         "translate": "0px 22.0522%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2742.4000000059605,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 905.8322143554688,
+       "right": 1265.832275390625,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 905.8322143554688,
+       "y": 16,
+     },
+     "opacity": "0.885486",
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
+         "translate": "0px 34.6129%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2758.9000000059605,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 905.0725708007812,
+       "right": 1265.072509765625,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 905.0725708007812,
+       "y": 16,
+     },
+     "opacity": "0.932965",
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
+         "translate": "0px 46.8552%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2775.5,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 904.6137084960938,
+       "right": 1264.61376953125,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 904.6137084960938,
+       "y": 16,
+     },
+     "opacity": "0.961644",
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
+         "translate": "0px 57.5738%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2792.300000011921,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 904.328125,
+       "right": 1264.328125,
+       "top": 16,
+       "width": 360,
+       "x": 904.328125,
+       "y": 16,
+     },
+     "opacity": "0.979493",
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
+         "translate": "0px 66.6456%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2808.9000000059605,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 904.1546630859375,
+       "right": 1264.1546630859375,
+       "top": 16,
+       "width": 360,
+       "x": 904.1546630859375,
+       "y": 16,
+     },
+     "opacity": "0.990333",
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
+         "translate": "0px 74.1344%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2825.600000023842,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 904.05615234375,
+       "right": 1264.05615234375,
+       "top": 16,
+       "width": 360,
+       "x": 904.05615234375,
+       "y": 16,
+     },
+     "opacity": "0.996489",
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
+         "translate": "0px 80.2665%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2842.2000000178814,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 904.0099487304688,
+       "right": 1264.010009765625,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 904.0099487304688,
+       "y": 16,
+     },
+     "opacity": "0.999379",
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
+         "translate": "0px 85.2316%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2858.9000000059605,
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