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
+ Received  + 1742

- Array []
+ Array [
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 912,
+       "right": 1272,
+       "top": 16,
+       "width": 360,
+       "x": 912,
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
+         "opacity": "0",
+         "scale": "0.9",
+         "translate": "none",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 1098,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 903.8344116210938,
+       "right": 1263.83447265625,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 903.8344116210938,
+       "y": 16,
+     },
+     "opacity": "0.510349",
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
+     "t": 1121,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 898.06103515625,
+       "right": 1258.06103515625,
+       "top": 16,
+       "width": 360,
+       "x": 898.06103515625,
+       "y": 16,
+     },
+     "opacity": "0.875247",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.306667",
+         "scale": "0.930667",
+         "translate": "none",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 1160,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.8627319335938,
+       "right": 1256.86279296875,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 896.8627319335938,
+       "y": 16,
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
+         "ending": false,
+         "opacity": "0.578826",
+         "scale": "0.957883",
+         "translate": "none",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 1187,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.6350708007812,
+       "right": 1256.635009765625,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 896.6350708007812,
+       "y": 16,
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
+         "ending": false,
+         "opacity": "0.653024",
+         "scale": "0.965302",
+         "translate": "none",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 1196,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.3509521484375,
+       "right": 1256.3509521484375,
+       "top": 16,
+       "width": 360,
+       "x": 896.3509521484375,
+       "y": 16,
+     },
+     "opacity": "0.978065",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.759572",
+         "scale": "0.975957",
+         "translate": "none",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 1212,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.1422729492188,
+       "right": 1256.142333984375,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 896.1422729492188,
+       "y": 16,
+     },
+     "opacity": "0.991108",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.855839",
+         "scale": "0.985584",
+         "translate": "none",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 1232,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.0698852539062,
+       "right": 1256.06982421875,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 896.0698852539062,
+       "y": 16,
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
+         "ending": false,
+         "opacity": "0.901368",
+         "scale": "0.990137",
+         "translate": "none",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 1244,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.0166015625,
+       "right": 1256.0166015625,
+       "top": 16,
+       "width": 360,
+       "x": 896.0166015625,
+       "y": 16,
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
+         "ending": false,
+         "opacity": "0.942954",
+         "scale": "0.994295",
+         "translate": "none",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 1260,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.0000610351562,
+       "right": 1256,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 896.0000610351562,
+       "y": 16,
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
+         "ending": false,
+         "opacity": "0.971519",
+         "scale": "0.997152",
+         "translate": "none",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 1277,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 912,
+       "right": 1272,
+       "top": 16,
+       "width": 360,
+       "x": 912,
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
+     "t": 1405,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 899.9868774414062,
+       "right": 1259.98681640625,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 899.9868774414062,
+       "y": 16,
+     },
+     "opacity": "0.750819",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
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
+     "t": 1448,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.6807250976562,
+       "right": 1256.6806640625,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 896.6807250976562,
+       "y": 16,
+     },
+     "opacity": "0.958902",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.472858",
+         "scale": "0.947286",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1503,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.0127563476562,
+       "right": 1256.0126953125,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 896.0127563476562,
+       "y": 16,
+     },
+     "opacity": "0.999204",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.895107",
+         "scale": "0.989511",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1570,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 912,
+       "right": 1272,
+       "top": 16,
+       "width": 360,
+       "x": 912,
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
+     "t": 1733,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 899.2538452148438,
+       "right": 1259.25390625,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 899.2538452148438,
+       "y": 16,
+     },
+     "opacity": "0.796635",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
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
+     "t": 1781,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.5513305664062,
+       "right": 1256.55126953125,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 896.5513305664062,
+       "y": 16,
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
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.46242",
+         "scale": "0.946242",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1835,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.10205078125,
+       "right": 1256.10205078125,
+       "top": 16,
+       "width": 360,
+       "x": 896.10205078125,
+       "y": 16,
+     },
+     "opacity": "0.993623",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
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
+     "t": 1873,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.0698852539062,
+       "right": 1256.06982421875,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 896.0698852539062,
+       "y": 16,
+     },
+     "opacity": "0.995923",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.802403",
+         "scale": "0.98024",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1879,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.00439453125,
+       "right": 1256.00439453125,
+       "top": 16,
+       "width": 360,
+       "x": 896.00439453125,
+       "y": 16,
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
+         "opacity": "0.898269",
+         "scale": "0.989827",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1904,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 912,
+       "right": 1272,
+       "top": 16,
+       "width": 360,
+       "x": 912,
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
+     "t": 2097,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 900.9141235351562,
+       "right": 1260.9140625,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 900.9141235351562,
+       "y": 16,
+     },
+     "opacity": "0.692866",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+         "opacity": "0.738776",
+         "scale": "0.973878",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2133,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 897.017333984375,
+       "right": 1257.017333984375,
+       "top": 16,
+       "width": 360,
+       "x": 897.017333984375,
+       "y": 16,
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
+     "t": 2181,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.8069458007812,
+       "right": 1256.806884765625,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 896.8069458007812,
+       "y": 16,
+     },
+     "opacity": "0.949568",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+         "opacity": "0.240428",
+         "scale": "0.924043",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2188,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.4424438476562,
+       "right": 1256.4423828125,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 896.4424438476562,
+       "y": 16,
+     },
+     "opacity": "0.972346",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+         "opacity": "0.156409",
+         "scale": "0.915641",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2205,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.2409057617188,
+       "right": 1256.240966796875,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 896.2409057617188,
+       "y": 16,
+     },
+     "opacity": "0.984943",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+         "opacity": "0.101731",
+         "scale": "0.910173",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2220,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.0797729492188,
+       "right": 1256.079833984375,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 896.0797729492188,
+       "y": 16,
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
+         "ending": true,
+         "opacity": "0.048787",
+         "scale": "0.904879",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2241,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.03466796875,
+       "right": 1256.03466796875,
+       "top": 16,
+       "width": 360,
+       "x": 896.03466796875,
+       "y": 16,
+     },
+     "opacity": "0.997833",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+         "opacity": "0.029932",
+         "scale": "0.902993",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2252,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.001953125,
+       "right": 1256.001953125,
+       "top": 16,
+       "width": 360,
+       "x": 896.001953125,
+       "y": 16,
+     },
+     "opacity": "0.99988",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+         "opacity": "0.009801",
+         "scale": "0.90098",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2270,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 909.4843139648438,
+       "right": 1269.484375,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 909.4843139648438,
+       "y": 16,
+     },
+     "opacity": "0.157231",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+         "opacity": "0.979789",
+         "scale": "0.997979",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2340,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 899.8526000976562,
+       "right": 1259.8525390625,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 899.8526000976562,
+       "y": 16,
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
+         "opacity": "0.647638",
+         "scale": "0.964764",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2377,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 898.6691284179688,
+       "right": 1258.669189453125,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 898.6691284179688,
+       "y": 16,
+     },
+     "opacity": "0.833178",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+         "opacity": "0.53758",
+         "scale": "0.953758",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2388,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 897.3606567382812,
+       "right": 1257.360595703125,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 897.3606567382812,
+       "y": 16,
+     },
+     "opacity": "0.914961",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+         "opacity": "0.346976",
+         "scale": "0.934698",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2409,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 897.1216430664062,
+       "right": 1257.12158203125,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 897.1216430664062,
+       "y": 16,
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
+         "ending": true,
+         "opacity": "0.303455",
+         "scale": "0.930346",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2415,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.6575927734375,
+       "right": 1256.6575927734375,
+       "top": 16,
+       "width": 360,
+       "x": 896.6575927734375,
+       "y": 16,
+     },
+     "opacity": "0.958902",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+         "opacity": "0.207724",
+         "scale": "0.920772",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2431,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.3651123046875,
+       "right": 1256.3651123046875,
+       "top": 16,
+       "width": 360,
+       "x": 896.3651123046875,
+       "y": 16,
+     },
+     "opacity": "0.97718",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2447,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.1741333007812,
+       "right": 1256.174072265625,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 896.1741333007812,
+       "y": 16,
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
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.081332",
+         "scale": "0.908133",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2464,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.0652465820312,
+       "right": 1256.065185546875,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 896.0652465820312,
+       "y": 16,
+     },
+     "opacity": "0.995923",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+     "t": 2481,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.0166015625,
+       "right": 1256.0166015625,
+       "top": 16,
+       "width": 360,
+       "x": 896.0166015625,
+       "y": 16,
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
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2496,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.0000610351562,
+       "right": 1256,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 896.0000610351562,
+       "y": 16,
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
+     "t": 2513,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 910.2062377929688,
+       "right": 1270.206298828125,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 910.2062377929688,
+       "y": 16,
+     },
+     "opacity": "0.11211",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.986879",
+         "scale": "0.998688",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2592,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 899.7234497070312,
+       "right": 1259.723388671875,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 899.7234497070312,
+       "y": 16,
+     },
+     "opacity": "0.767284",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.636282",
+         "scale": "0.963628",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2632,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 898.8499145507812,
+       "right": 1258.849853515625,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 898.8499145507812,
+       "y": 16,
+     },
+     "opacity": "0.821879",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.558815",
+         "scale": "0.955882",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2640,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.7045288085938,
+       "right": 1256.70458984375,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 896.7045288085938,
+       "y": 16,
+     },
+     "opacity": "0.955968",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.21823",
+         "scale": "0.921823",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2683,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.3947143554688,
+       "right": 1256.394775390625,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 896.3947143554688,
+       "y": 16,
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
+         "ending": true,
+         "opacity": "0.144161",
+         "scale": "0.914416",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2699,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.2409057617188,
+       "right": 1256.240966796875,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 896.2409057617188,
+       "y": 16,
+     },
+     "opacity": "0.985598",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.098632",
+         "scale": "0.909863",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2712,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.1349487304688,
+       "right": 1256.135009765625,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 896.1349487304688,
+       "y": 16,
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
+         "ending": true,
+         "opacity": "0.068513",
+         "scale": "0.906851",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2723,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.0260009765625,
+       "right": 1256.0260009765625,
+       "top": 16,
+       "width": 360,
+       "x": 896.0260009765625,
+       "y": 16,
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
+         "ending": true,
+         "opacity": "0.025703",
+         "scale": "0.90257",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2746,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.0079956054688,
+       "right": 1256.008056640625,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 896.0079956054688,
+       "y": 16,
+     },
+     "opacity": "0.9995",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.015159",
+         "scale": "0.901516",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2755,
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