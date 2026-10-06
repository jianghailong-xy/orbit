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
+ Received  + 2318

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
+         "opacity": "1",
+         "scale": "none",
+         "translate": "0px 100%",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 953,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 905.9806518554688,
+       "right": 1265.980712890625,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 905.9806518554688,
+       "y": 16,
+     },
+     "opacity": "0.376208",
+     "overlays": Array [
+       Object {
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
+     "t": 970,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 899.5991821289062,
+       "right": 1259.59912109375,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 899.5991821289062,
+       "y": 16,
+     },
+     "opacity": "0.775049",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "0px 90.52037%",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 999,
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
+     "opacity": "0.871186",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "0px 80.068687%",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 1016,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 897.546142578125,
+       "right": 1257.546142578125,
+       "top": 16,
+       "width": 360,
+       "x": 897.546142578125,
+       "y": 16,
+     },
+     "opacity": "0.903365",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "0px 73.502319%",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 1025,
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
+         "translate": "0px 63.628227%",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 1038,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.592041015625,
+       "right": 1256.592041015625,
+       "top": 16,
+       "width": 360,
+       "x": 896.592041015625,
+       "y": 16,
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
+         "translate": "0px 52.025387%",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 1054,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.3109130859375,
+       "right": 1256.3109130859375,
+       "top": 16,
+       "width": 360,
+       "x": 896.3109130859375,
+       "y": 16,
+     },
+     "opacity": "0.980567",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "0px 41.237812%",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 1071,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.1576538085938,
+       "right": 1256.15771484375,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 896.1576538085938,
+       "y": 16,
+     },
+     "opacity": "0.990146",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "0px 33.196209%",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 1086,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.0565185546875,
+       "right": 1256.0565185546875,
+       "top": 16,
+       "width": 360,
+       "x": 896.0565185546875,
+       "y": 16,
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
+         "translate": "0px 25.61475%",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 1103,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.0110473632812,
+       "right": 1256.010986328125,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 896.0110473632812,
+       "y": 16,
+     },
+     "opacity": "0.999311",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "0px 19.759661%",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 1119,
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
+     "t": 1330,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 906.653076171875,
+       "right": 1266.653076171875,
+       "top": 16,
+       "width": 360,
+       "x": 906.653076171875,
+       "y": 16,
+     },
+     "opacity": "0.334182",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
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
+     "t": 1344,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 901.8740234375,
+       "right": 1261.8740234375,
+       "top": 16,
+       "width": 360,
+       "x": 901.8740234375,
+       "y": 16,
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
+         "opacity": "0.079998",
+         "scale": "0.908",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1361,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 898.4210815429688,
+       "right": 1258.421142578125,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 898.4210815429688,
+       "y": 16,
+     },
+     "opacity": "0.848682",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.340967",
+         "scale": "0.934097",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1387,
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
+     "opacity": "0.871186",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.397427",
+         "scale": "0.939743",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1392,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 897.196533203125,
+       "right": 1257.196533203125,
+       "top": 16,
+       "width": 360,
+       "x": 897.196533203125,
+       "y": 16,
+     },
+     "opacity": "0.925215",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.569889",
+         "scale": "0.956989",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1409,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.6132202148438,
+       "right": 1256.61328125,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 896.6132202148438,
+       "y": 16,
+     },
+     "opacity": "0.961672",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.723114",
+         "scale": "0.972311",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1429,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.3372192382812,
+       "right": 1256.337158203125,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 896.3372192382812,
+       "y": 16,
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
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.812163",
+         "scale": "0.981216",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1445,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.165771484375,
+       "right": 1256.165771484375,
+       "top": 16,
+       "width": 360,
+       "x": 896.165771484375,
+       "y": 16,
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
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.878308",
+         "scale": "0.987831",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1461,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.060791015625,
+       "right": 1256.060791015625,
+       "top": 16,
+       "width": 360,
+       "x": 896.060791015625,
+       "y": 16,
+     },
+     "opacity": "0.996202",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
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
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1478,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.0145874023438,
+       "right": 1256.0146484375,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 896.0145874023438,
+       "y": 16,
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
+         "opacity": "0.960459",
+         "scale": "0.996046",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1493,
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
+         "ending": false,
+         "opacity": "0.982766",
+         "scale": "0.998277",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1509,
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
+     "t": 1607,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 901.09130859375,
+       "right": 1261.09130859375,
+       "top": 16,
+       "width": 360,
+       "x": 901.09130859375,
+       "y": 16,
+     },
+     "opacity": "0.681792",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
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
+     "t": 1642,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 898.4210815429688,
+       "right": 1258.421142578125,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 898.4210815429688,
+       "y": 16,
+     },
+     "opacity": "0.848682",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.127913",
+         "scale": "0.912791",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1664,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.592041015625,
+       "right": 1256.592041015625,
+       "top": 16,
+       "width": 360,
+       "x": 896.592041015625,
+       "y": 16,
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
+         "ending": false,
+         "opacity": "0.569889",
+         "scale": "0.956989",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1707,
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
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.675352",
+         "scale": "0.967535",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1720,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.1498413085938,
+       "right": 1256.14990234375,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 896.1498413085938,
+       "y": 16,
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
+         "ending": false,
+         "opacity": "0.797387",
+         "scale": "0.979739",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1740,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.07470703125,
+       "right": 1256.07470703125,
+       "top": 16,
+       "width": 360,
+       "x": 896.07470703125,
+       "y": 16,
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
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.851834",
+         "scale": "0.985183",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1752,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.0187377929688,
+       "right": 1256.018798828125,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 896.0187377929688,
+       "y": 16,
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
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.907377",
+         "scale": "0.990738",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1768,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.0001831054688,
+       "right": 1256.000244140625,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 896.0001831054688,
+       "y": 16,
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
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.947182",
+         "scale": "0.994718",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1784,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 909.123779296875,
+       "right": 1269.123779296875,
+       "top": 16,
+       "width": 360,
+       "x": 909.123779296875,
+       "y": 16,
+     },
+     "opacity": "0.179763",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 1880,
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
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.670457",
+         "scale": "0.967046",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 1915,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 898.5008544921875,
+       "right": 1258.5008544921875,
+       "top": 16,
+       "width": 360,
+       "x": 898.5008544921875,
+       "y": 16,
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
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+         "opacity": "0.516831",
+         "scale": "0.951683",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 1929,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 897.4976196289062,
+       "right": 1257.49755859375,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 897.4976196289062,
+       "y": 16,
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
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 1945,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.891845703125,
+       "right": 1256.891845703125,
+       "top": 16,
+       "width": 360,
+       "x": 896.891845703125,
+       "y": 16,
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
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+         "opacity": "0.258166",
+         "scale": "0.925817",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 1961,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.5318603515625,
+       "right": 1256.5318603515625,
+       "top": 16,
+       "width": 360,
+       "x": 896.5318603515625,
+       "y": 16,
+     },
+     "opacity": "0.966758",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 1976,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.2742919921875,
+       "right": 1256.2742919921875,
+       "top": 16,
+       "width": 360,
+       "x": 896.2742919921875,
+       "y": 16,
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
+     "t": 1993,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.1278686523438,
+       "right": 1256.1279296875,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 896.1278686523438,
+       "y": 16,
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
+         "opacity": "0.063769",
+         "scale": "0.906377",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2009,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.0447998046875,
+       "right": 1256.0447998046875,
+       "top": 16,
+       "width": 360,
+       "x": 896.0447998046875,
+       "y": 16,
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
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.032961",
+         "scale": "0.903296",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2025,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.0066528320312,
+       "right": 1256.006591796875,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 896.0066528320312,
+       "y": 16,
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
+     "t": 2041,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 908.4058227539062,
+       "right": 1268.40576171875,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 908.4058227539062,
+       "y": 16,
+     },
+     "opacity": "0.224635",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+     "t": 2110,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 903.559326171875,
+       "right": 1263.559326171875,
+       "top": 16,
+       "width": 360,
+       "x": 903.559326171875,
+       "y": 16,
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
+         "ending": true,
+         "opacity": "0.933587",
+         "scale": "0.993359",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2125,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 900.743896484375,
+       "right": 1260.743896484375,
+       "top": 16,
+       "width": 360,
+       "x": 900.743896484375,
+       "y": 16,
+     },
+     "opacity": "0.713735",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+         "opacity": "0.814543",
+         "scale": "0.981454",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2138,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 898.58349609375,
+       "right": 1258.58349609375,
+       "top": 16,
+       "width": 360,
+       "x": 898.58349609375,
+       "y": 16,
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
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.613739",
+         "scale": "0.961374",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2157,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 897.5963134765625,
+       "right": 1257.5963134765625,
+       "top": 16,
+       "width": 360,
+       "x": 897.5963134765625,
+       "y": 16,
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
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.467267",
+         "scale": "0.946727",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2171,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.9527587890625,
+       "right": 1256.9527587890625,
+       "top": 16,
+       "width": 360,
+       "x": 896.9527587890625,
+       "y": 16,
+     },
+     "opacity": "0.940452",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
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
+         "opacity": "0.331962",
+         "scale": "0.933196",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2187,
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
+         "ending": true,
+         "opacity": "0.223629",
+         "scale": "0.922363",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2203,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.29833984375,
+       "right": 1256.29833984375,
+       "top": 16,
+       "width": 360,
+       "x": 896.29833984375,
+       "y": 16,
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
+         "ending": true,
+         "opacity": "0.152248",
+         "scale": "0.915225",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2219,
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
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.095597",
+         "scale": "0.90956",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2235,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.0447998046875,
+       "right": 1256.0447998046875,
+       "top": 16,
+       "width": 360,
+       "x": 896.0447998046875,
+       "y": 16,
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
+         "opacity": "0.050778",
+         "scale": "0.905078",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2253,
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
+         "opacity": "0.024375",
+         "scale": "0.902437",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2268,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 910.56689453125,
+       "right": 1270.56689453125,
+       "top": 16,
+       "width": 360,
+       "x": 910.56689453125,
+       "y": 16,
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
+         "ending": true,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "0px 0.620518%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2354,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 903.559326171875,
+       "right": 1263.559326171875,
+       "top": 16,
+       "width": 360,
+       "x": 903.559326171875,
+       "y": 16,
+     },
+     "opacity": "0.544202",
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
+         "translate": "0px 7.533437%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2376,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 902.31298828125,
+       "right": 1262.31298828125,
+       "top": 16,
+       "width": 360,
+       "x": 902.31298828125,
+       "y": 16,
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
+         "ending": true,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "0px 9.47963%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2380,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 899.5991821289062,
+       "right": 1259.59912109375,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 899.5991821289062,
+       "y": 16,
+     },
+     "opacity": "0.775049",
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
+         "translate": "0px 19.234327%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2396,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 898.1282348632812,
+       "right": 1258.128173828125,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 898.1282348632812,
+       "y": 16,
+     },
+     "opacity": "0.866987",
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
+     "sameNode": true,
+     "t": 2412,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 897.276123046875,
+       "right": 1257.276123046875,
+       "top": 16,
+       "width": 360,
+       "x": 897.276123046875,
+       "y": 16,
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
+         "ending": true,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "0px 43.760098%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2428,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.7542114257812,
+       "right": 1256.754150390625,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 896.7542114257812,
+       "y": 16,
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
+         "ending": true,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "0px 54.5368%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2445,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.41015625,
+       "right": 1256.41015625,
+       "top": 16,
+       "width": 360,
+       "x": 896.41015625,
+       "y": 16,
+     },
+     "opacity": "0.974364",
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
+     "sameNode": true,
+     "t": 2461,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.21044921875,
+       "right": 1256.21044921875,
+       "top": 16,
+       "width": 360,
+       "x": 896.21044921875,
+       "y": 16,
+     },
+     "opacity": "0.986846",
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
+     "sameNode": true,
+     "t": 2477,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.0904541015625,
+       "right": 1256.0904541015625,
+       "top": 16,
+       "width": 360,
+       "x": 896.0904541015625,
+       "y": 16,
+     },
+     "opacity": "0.994345",
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
+     "sameNode": true,
+     "t": 2493,
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
+         "opacity": "1",
+         "scale": "none",
+         "translate": "0px 83.062607%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2509,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.0013427734375,
+       "right": 1256.0013427734375,
+       "top": 16,
+       "width": 360,
+       "x": 896.0013427734375,
+       "y": 16,
+     },
+     "opacity": "0.999917",
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
+         "translate": "0px 87.593903%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2525,
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