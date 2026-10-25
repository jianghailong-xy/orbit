Inventory `8-before-cleanup`: 4 mappings; Docker: 4 runner containers, 4 data volumes (instance `orbit-d4-e1a08e4f`). Agree: **True**.

| account | state | gen | volume (DB) = Docker | volume UID (DB) = label | container (Docker) | container UID = pod_uid | gen label | state | agree |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| admin@d4.test | STARTING | 1 | mr-data-01a15b9c-5f4d-7409-9efc-efcc4e097f6b = present | 6d6275bb = 6d6275bb | mr-01a15b9c-5f4d-7409-9efc-efcc4e097f6b 5b6b77f2841c | a703f107 = a703f107 | 1 | running | yes |
| alice@d4.test | READY | 3 | mr-data-01a15b9c-c69f-718f-ba2a-90bd8a35230f = present | 13398645 = 13398645 | mr-01a15b9c-c69f-718f-ba2a-90bd8a35230f f0561aac1b60 | 76372104 = 76372104 | 3 | running | yes |
| bob@d4.test | STARTING | 1 | mr-data-01a15b9d-4ed5-745c-b5b7-3d6e774c61c6 = present | bcd0a960 = bcd0a960 | mr-01a15b9d-4ed5-745c-b5b7-3d6e774c61c6 b6a8b1388953 | 257c82a0 = 257c82a0 | 1 | running | yes |
| carol@d4.test | STARTING | 1 | mr-data-01a15ba9-a49e-7204-a0b2-6eae30a83d9e = present | 73a655f6 = 73a655f6 | mr-01a15ba9-a49e-7204-a0b2-6eae30a83d9e 4c35fb746a28 | 9725f650 = 9725f650 | 1 | running | yes |

Stray data volumes (no mapping): none; stray runner containers: none; boot volumes: ['mr-boot-01a15b9c-5f4d-7409-9efc-efcc4e097f6b-g1', 'mr-boot-01a15b9c-c69f-718f-ba2a-90bd8a35230f-g3', 'mr-boot-01a15b9d-4ed5-745c-b5b7-3d6e774c61c6-g1', 'mr-boot-01a15ba9-a49e-7204-a0b2-6eae30a83d9e-g1'].
Containers per data volume: {'mr-data-01a15b9c-c69f-718f-ba2a-90bd8a35230f': 1, 'mr-data-01a15ba9-a49e-7204-a0b2-6eae30a83d9e': 1, 'mr-data-01a15b9d-4ed5-745c-b5b7-3d6e774c61c6': 1, 'mr-data-01a15b9c-5f4d-7409-9efc-efcc4e097f6b': 1}; mappings per account: {'admin@d4.test': 1, 'alice@d4.test': 1, 'bob@d4.test': 1, 'carol@d4.test': 1}; runner rows per account: {'admin@d4.test': 1, 'alice@d4.test': 1, 'bob@d4.test': 1, 'carol@d4.test': 1}.
