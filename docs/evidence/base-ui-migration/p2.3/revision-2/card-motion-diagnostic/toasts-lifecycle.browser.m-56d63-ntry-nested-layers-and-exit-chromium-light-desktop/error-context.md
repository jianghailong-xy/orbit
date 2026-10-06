# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: toasts-lifecycle.browser.mjs >> notification card stays fixed through Drawer entry, nested layers and exit
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
+         "translate": "100%",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 1187.2000000178814,
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
+         "translate": "100%",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 1189.0999999940395,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 914.102783203125,
+       "right": 1274.102783203125,
+       "top": 16,
+       "width": 360,
+       "x": 914.102783203125,
+       "y": 16,
+     },
+     "opacity": "0.368576",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "100%",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 1205.800000011921,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 909.5996704101562,
+       "right": 1269.5997314453125,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 909.5996704101562,
+       "y": 16,
+     },
+     "opacity": "0.650019",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "100%",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 1222.2000000178814,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 907.143798828125,
+       "right": 1267.143798828125,
+       "top": 16,
+       "width": 360,
+       "x": 907.143798828125,
+       "y": 16,
+     },
+     "opacity": "0.803512",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "96.1556%",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 1238.800000011921,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 905.8349609375,
+       "right": 1265.8349609375,
+       "top": 16,
+       "width": 360,
+       "x": 905.8349609375,
+       "y": 16,
+     },
+     "opacity": "0.885314",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "88.7555%",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 1255.300000011921,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 905.07421875,
+       "right": 1265.07421875,
+       "top": 16,
+       "width": 360,
+       "x": 905.07421875,
+       "y": 16,
+     },
+     "opacity": "0.932863",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "77.9326%",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 1272.0999999940395,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 904.6146850585938,
+       "right": 1264.61474609375,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 904.6146850585938,
+       "y": 16,
+     },
+     "opacity": "0.961581",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "65.4471%",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 1288.7000000178814,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 904.327392578125,
+       "right": 1264.327392578125,
+       "top": 16,
+       "width": 360,
+       "x": 904.327392578125,
+       "y": 16,
+     },
+     "opacity": "0.979537",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "53.1302%",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 1305.4000000059605,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 904.155029296875,
+       "right": 1264.155029296875,
+       "top": 16,
+       "width": 360,
+       "x": 904.155029296875,
+       "y": 16,
+     },
+     "opacity": "0.99031",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "42.4138%",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 1322,
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
+     "opacity": "0.996477",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "33.344%",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 1340.5999999940395,
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
+     "opacity": "0.999374",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "25.8977%",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 1355.300000011921,
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
+     "t": 1596,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 914.0974731445312,
+       "right": 1274.097412109375,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 914.0974731445312,
+       "y": 16,
+     },
+     "opacity": "0.368909",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
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
+     "t": 1607.0999999940395,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 909.5964965820312,
+       "right": 1269.596435546875,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 909.5964965820312,
+       "y": 16,
+     },
+     "opacity": "0.65022",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.0709085",
+         "scale": "0.907091",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1622.5,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 907.152587890625,
+       "right": 1267.152587890625,
+       "top": 16,
+       "width": 360,
+       "x": 907.152587890625,
+       "y": 16,
+     },
+     "opacity": "0.802962",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.220118",
+         "scale": "0.922012",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1638.7000000178814,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 905.8340454101562,
+       "right": 1265.833984375,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 905.8340454101562,
+       "y": 16,
+     },
+     "opacity": "0.885372",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.408312",
+         "scale": "0.940831",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1655.300000011921,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 905.0736083984375,
+       "right": 1265.0736083984375,
+       "top": 16,
+       "width": 360,
+       "x": 905.0736083984375,
+       "y": 16,
+     },
+     "opacity": "0.932898",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.575999",
+         "scale": "0.9576",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1672,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 904.6121826171875,
+       "right": 1264.6121826171875,
+       "top": 16,
+       "width": 360,
+       "x": 904.6121826171875,
+       "y": 16,
+     },
+     "opacity": "0.961737",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.705938",
+         "scale": "0.970594",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1688.5999999940395,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 904.3285522460938,
+       "right": 1264.3284912109375,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 904.3285522460938,
+       "y": 16,
+     },
+     "opacity": "0.979467",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.802314",
+         "scale": "0.980231",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1706.5999999940395,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 904.1557006835938,
+       "right": 1264.15576171875,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 904.1557006835938,
+       "y": 16,
+     },
+     "opacity": "0.990269",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.873232",
+         "scale": "0.987323",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1722,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 904.0563354492188,
+       "right": 1264.0562744140625,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 904.0563354492188,
+       "y": 16,
+     },
+     "opacity": "0.996481",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.924949",
+         "scale": "0.992495",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1738.7000000178814,
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
+     "opacity": "0.999376",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.960428",
+         "scale": "0.996043",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1755.800000011921,
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
+     "t": 1893.7000000178814,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 914.0934448242188,
+       "right": 1274.093505859375,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 914.0934448242188,
+       "y": 16,
+     },
+     "opacity": "0.369158",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
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
+     "t": 1906,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 909.6141357421875,
+       "right": 1269.6141357421875,
+       "top": 16,
+       "width": 360,
+       "x": 909.6141357421875,
+       "y": 16,
+     },
+     "opacity": "0.649115",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.0703205",
+         "scale": "0.907032",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1922,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 907.1513671875,
+       "right": 1267.1513671875,
+       "top": 16,
+       "width": 360,
+       "x": 907.1513671875,
+       "y": 16,
+     },
+     "opacity": "0.80304",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.220248",
+         "scale": "0.922025",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1938.9000000059605,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 905.8333129882812,
+       "right": 1265.8333740234375,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 905.8333129882812,
+       "y": 16,
+     },
+     "opacity": "0.885416",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.408444",
+         "scale": "0.940844",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1955.4000000059605,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 905.0732421875,
+       "right": 1265.0732421875,
+       "top": 16,
+       "width": 360,
+       "x": 905.0732421875,
+       "y": 16,
+     },
+     "opacity": "0.932924",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.576106",
+         "scale": "0.957611",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1972,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 904.6141357421875,
+       "right": 1264.6141357421875,
+       "top": 16,
+       "width": 360,
+       "x": 904.6141357421875,
+       "y": 16,
+     },
+     "opacity": "0.961618",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.705347",
+         "scale": "0.970535",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1988.7000000178814,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 904.328369140625,
+       "right": 1264.328369140625,
+       "top": 16,
+       "width": 360,
+       "x": 904.328369140625,
+       "y": 16,
+     },
+     "opacity": "0.979477",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.802374",
+         "scale": "0.980237",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 2005.4000000059605,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 904.15478515625,
+       "right": 1264.15478515625,
+       "top": 16,
+       "width": 360,
+       "x": 904.15478515625,
+       "y": 16,
+     },
+     "opacity": "0.990324",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.873638",
+         "scale": "0.987364",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 2022.2000000178814,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 904.0567016601562,
+       "right": 1264.056640625,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 904.0567016601562,
+       "y": 16,
+     },
+     "opacity": "0.996458",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.924723",
+         "scale": "0.992472",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 2038.7000000178814,
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
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.960449",
+         "scale": "0.996045",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 2055.4000000059605,
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
+     "t": 2150.7000000178814,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 914.0901489257812,
+       "right": 1274.090087890625,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 914.0901489257812,
+       "y": 16,
+     },
+     "opacity": "0.369366",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+         "opacity": "0.929172",
+         "scale": "0.992917",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2167.2000000178814,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 909.5921020507812,
+       "right": 1269.592041015625,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 909.5921020507812,
+       "y": 16,
+     },
+     "opacity": "0.650495",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+         "opacity": "0.778929",
+         "scale": "0.977893",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2179.9000000059605,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 907.1503295898438,
+       "right": 1267.1502685546875,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 907.1503295898438,
+       "y": 16,
+     },
+     "opacity": "0.803106",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+         "opacity": "0.591821",
+         "scale": "0.959182",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2193.7000000178814,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 905.832763671875,
+       "right": 1265.832763671875,
+       "top": 16,
+       "width": 360,
+       "x": 905.832763671875,
+       "y": 16,
+     },
+     "opacity": "0.885453",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+         "opacity": "0.424108",
+         "scale": "0.942411",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2207.5999999940395,
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
+     "opacity": "0.932946",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+         "opacity": "0.294143",
+         "scale": "0.929414",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2222,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 904.6138916015625,
+       "right": 1264.6138916015625,
+       "top": 16,
+       "width": 360,
+       "x": 904.6138916015625,
+       "y": 16,
+     },
+     "opacity": "0.961632",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+         "opacity": "0.197746",
+         "scale": "0.919775",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2238.5999999940395,
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
+     "opacity": "0.979485",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+         "opacity": "0.126449",
+         "scale": "0.912645",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2256.4000000059605,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 904.155517578125,
+       "right": 1264.155517578125,
+       "top": 16,
+       "width": 360,
+       "x": 904.155517578125,
+       "y": 16,
+     },
+     "opacity": "0.99028",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+         "opacity": "0.075339",
+         "scale": "0.907534",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2272,
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
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.0394198",
+         "scale": "0.903942",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2288.9000000059605,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 904.0101318359375,
+       "right": 1264.0101318359375,
+       "top": 16,
+       "width": 360,
+       "x": 904.0101318359375,
+       "y": 16,
+     },
+     "opacity": "0.999368",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+         "opacity": "0.0166275",
+         "scale": "0.901663",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2305.4000000059605,
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
+     "t": 2386.2000000178814,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 914.0648803710938,
+       "right": 1274.06494140625,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 914.0648803710938,
+       "y": 16,
+     },
+     "opacity": "0.370945",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+         "opacity": "0.928662",
+         "scale": "0.992866",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2398.2000000178814,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 909.5968627929688,
+       "right": 1269.596923828125,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 909.5968627929688,
+       "y": 16,
+     },
+     "opacity": "0.650195",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+         "opacity": "0.779189",
+         "scale": "0.977919",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2409.4000000059605,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 907.15283203125,
+       "right": 1267.15283203125,
+       "top": 16,
+       "width": 360,
+       "x": 907.15283203125,
+       "y": 16,
+     },
+     "opacity": "0.802949",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+         "opacity": "0.592086",
+         "scale": "0.959209",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2427.300000011921,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 905.8341674804688,
+       "right": 1265.834228515625,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 905.8341674804688,
+       "y": 16,
+     },
+     "opacity": "0.885365",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+         "opacity": "0.424322",
+         "scale": "0.942432",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2438.5999999940395,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 905.0772094726562,
+       "right": 1265.0771484375,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 905.0772094726562,
+       "y": 16,
+     },
+     "opacity": "0.932675",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+         "opacity": "0.294976",
+         "scale": "0.929498",
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
+       "left": 904.6122436523438,
+       "right": 1264.6123046875,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 904.6122436523438,
+       "y": 16,
+     },
+     "opacity": "0.961734",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+         "opacity": "0.197368",
+         "scale": "0.919737",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2471.9000000059605,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 904.3285522460938,
+       "right": 1264.32861328125,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 904.3285522460938,
+       "y": 16,
+     },
+     "opacity": "0.979465",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+         "opacity": "0.126536",
+         "scale": "0.912654",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2488.5,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 904.1549072265625,
+       "right": 1264.1549072265625,
+       "top": 16,
+       "width": 360,
+       "x": 904.1549072265625,
+       "y": 16,
+     },
+     "opacity": "0.990317",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+         "opacity": "0.0751434",
+         "scale": "0.907514",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2505.300000011921,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 904.0563354492188,
+       "right": 1264.0562744140625,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 904.0563354492188,
+       "y": 16,
+     },
+     "opacity": "0.99648",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+         "opacity": "0.0394613",
+         "scale": "0.903946",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2522,
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
+     "opacity": "0.999376",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+         "opacity": "0.0165476",
+         "scale": "0.901655",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2538.5999999940395,
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
+         "translate": "0%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2616.800000011921,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 914.0728759765625,
+       "right": 1274.0728759765625,
+       "top": 16,
+       "width": 360,
+       "x": 914.0728759765625,
+       "y": 16,
+     },
+     "opacity": "0.370447",
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
+         "translate": "3.85177%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2628.4000000059605,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 909.6016845703125,
+       "right": 1269.6016845703125,
+       "top": 16,
+       "width": 360,
+       "x": 909.6016845703125,
+       "y": 16,
+     },
+     "opacity": "0.649894",
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
+         "translate": "11.2567%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2639,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 907.1448364257812,
+       "right": 1267.1448974609375,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 907.1448364257812,
+       "y": 16,
+     },
+     "opacity": "0.803446",
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
+         "translate": "22.0833%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2655.4000000059605,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 905.8355712890625,
+       "right": 1265.8355712890625,
+       "top": 16,
+       "width": 360,
+       "x": 905.8355712890625,
+       "y": 16,
+     },
+     "opacity": "0.885277",
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
+         "translate": "34.5696%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2671.9000000059605,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 905.071044921875,
+       "right": 1265.071044921875,
+       "top": 16,
+       "width": 360,
+       "x": 905.071044921875,
+       "y": 16,
+     },
+     "opacity": "0.933059",
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
+         "translate": "46.8851%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2688.5999999940395,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 904.61279296875,
+       "right": 1264.61279296875,
+       "top": 16,
+       "width": 360,
+       "x": 904.61279296875,
+       "y": 16,
+     },
+     "opacity": "0.961702",
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
+         "translate": "57.5993%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2705.5999999940395,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 904.3275756835938,
+       "right": 1264.3275146484375,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 904.3275756835938,
+       "y": 16,
+     },
+     "opacity": "0.979528",
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
+         "translate": "66.6668%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2721.9000000059605,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 904.1550903320312,
+       "right": 1264.1551513671875,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 904.1550903320312,
+       "y": 16,
+     },
+     "opacity": "0.990305",
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
+         "translate": "74.1112%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2738.5,
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
+     "opacity": "0.996474",
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
+         "translate": "80.2476%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2755.5,
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
+         "ending": true,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "85.2163%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2771.9000000059605,
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
    - button "Open Drawer" [active] [ref=e32] [cursor=pointer]
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