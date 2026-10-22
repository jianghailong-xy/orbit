## Container and volume lifecycle (Docker's events, this instance's label)

| time (UTC) | object | action | name | generation | exit |
| --- | --- | --- | --- | --- | --- |
| 08:34:31 | container | create | mr-01a148ff-9266-76cf-bca2-740a4be859ce | 1 |  |
| 08:34:31 | container | extract-to-dir | mr-01a148ff-9266-76cf-bca2-740a4be859ce | 1 |  |
| 08:34:31 | container | start | mr-01a148ff-9266-76cf-bca2-740a4be859ce | 1 |  |
| 08:34:31 | container | create | mr-01a148ff-9275-71ab-a08e-91125366d737 | 1 |  |
| 08:34:31 | container | extract-to-dir | mr-01a148ff-9275-71ab-a08e-91125366d737 | 1 |  |
| 08:34:31 | container | start | mr-01a148ff-9275-71ab-a08e-91125366d737 | 1 |  |
| 08:35:01 | container | kill | mr-01a148ff-9266-76cf-bca2-740a4be859ce | 1 |  |
| 08:35:02 | container | die | mr-01a148ff-9266-76cf-bca2-740a4be859ce | 1 | 137 |
| 08:35:02 | container | destroy | mr-01a148ff-9266-76cf-bca2-740a4be859ce | 1 |  |
| 08:35:02 | container | create | mr-01a148ff-9266-76cf-bca2-740a4be859ce | 2 |  |
| 08:35:02 | container | extract-to-dir | mr-01a148ff-9266-76cf-bca2-740a4be859ce | 2 |  |
| 08:35:03 | container | start | mr-01a148ff-9266-76cf-bca2-740a4be859ce | 2 |  |
| 08:37:03 | container | die | mr-01a148ff-9266-76cf-bca2-740a4be859ce | 2 | 0 |
| 08:37:03 | container | destroy | mr-01a148ff-9266-76cf-bca2-740a4be859ce | 2 |  |
| 08:37:04 | container | create | mr-01a148ff-9266-76cf-bca2-740a4be859ce | 3 |  |
| 08:37:04 | container | extract-to-dir | mr-01a148ff-9266-76cf-bca2-740a4be859ce | 3 |  |
| 08:37:04 | container | start | mr-01a148ff-9266-76cf-bca2-740a4be859ce | 3 |  |
| 08:38:04 | container | die | mr-01a148ff-9266-76cf-bca2-740a4be859ce | 3 | 0 |
| 08:38:04 | container | destroy | mr-01a148ff-9266-76cf-bca2-740a4be859ce | 3 |  |
| 08:38:05 | container | create | mr-01a148ff-9266-76cf-bca2-740a4be859ce | 4 |  |
| 08:38:05 | container | extract-to-dir | mr-01a148ff-9266-76cf-bca2-740a4be859ce | 4 |  |
| 08:38:05 | container | start | mr-01a148ff-9266-76cf-bca2-740a4be859ce | 4 |  |
| 08:39:35 | container | die | mr-01a148ff-9266-76cf-bca2-740a4be859ce | 4 | 0 |
| 08:39:36 | container | destroy | mr-01a148ff-9266-76cf-bca2-740a4be859ce | 4 |  |
| 08:39:36 | container | create | mr-01a148ff-9266-76cf-bca2-740a4be859ce | 5 |  |
| 08:39:36 | container | extract-to-dir | mr-01a148ff-9266-76cf-bca2-740a4be859ce | 5 |  |
| 08:39:36 | container | start | mr-01a148ff-9266-76cf-bca2-740a4be859ce | 5 |  |
| 08:40:37 | container | die | mr-01a148ff-9266-76cf-bca2-740a4be859ce | 5 | 0 |
| 08:40:37 | container | destroy | mr-01a148ff-9266-76cf-bca2-740a4be859ce | 5 |  |
| 08:40:37 | container | create | mr-01a148ff-9266-76cf-bca2-740a4be859ce | 6 |  |
| 08:40:37 | container | extract-to-dir | mr-01a148ff-9266-76cf-bca2-740a4be859ce | 6 |  |
| 08:40:37 | container | start | mr-01a148ff-9266-76cf-bca2-740a4be859ce | 6 |  |
| 08:41:10 | container | kill | mr-01a148ff-9266-76cf-bca2-740a4be859ce | 6 |  |
| 08:41:10 | container | die | mr-01a148ff-9266-76cf-bca2-740a4be859ce | 6 | 137 |
| 08:41:11 | container | destroy | mr-01a148ff-9266-76cf-bca2-740a4be859ce | 6 |  |
| 08:41:11 | container | create | mr-01a148ff-9266-76cf-bca2-740a4be859ce | 7 |  |
| 08:41:11 | container | extract-to-dir | mr-01a148ff-9266-76cf-bca2-740a4be859ce | 7 |  |
| 08:41:11 | container | start | mr-01a148ff-9266-76cf-bca2-740a4be859ce | 7 |  |
| 08:41:31 | container | die | mr-01a148ff-9275-71ab-a08e-91125366d737 | 1 | 0 |
| 08:41:32 | container | destroy | mr-01a148ff-9275-71ab-a08e-91125366d737 | 1 |  |
| 08:42:11 | container | die | mr-01a148ff-9266-76cf-bca2-740a4be859ce | 7 | 0 |
| 08:42:12 | container | destroy | mr-01a148ff-9266-76cf-bca2-740a4be859ce | 7 |  |
| 08:42:12 | container | create | mr-01a148ff-9266-76cf-bca2-740a4be859ce | 8 |  |
| 08:42:12 | container | extract-to-dir | mr-01a148ff-9266-76cf-bca2-740a4be859ce | 8 |  |
| 08:42:12 | container | start | mr-01a148ff-9266-76cf-bca2-740a4be859ce | 8 |  |
| 08:43:12 | container | die | mr-01a148ff-9266-76cf-bca2-740a4be859ce | 8 | 0 |
| 08:43:13 | container | destroy | mr-01a148ff-9266-76cf-bca2-740a4be859ce | 8 |  |
| 08:43:14 | container | create | mr-01a148ff-9266-76cf-bca2-740a4be859ce | 9 |  |
| 08:43:14 | container | extract-to-dir | mr-01a148ff-9266-76cf-bca2-740a4be859ce | 9 |  |
| 08:43:14 | container | start | mr-01a148ff-9266-76cf-bca2-740a4be859ce | 9 |  |
| 08:43:45 | container | create | mr-01a148ff-9275-71ab-a08e-91125366d737 | 2 |  |
| 08:43:45 | container | extract-to-dir | mr-01a148ff-9275-71ab-a08e-91125366d737 | 2 |  |
| 08:43:45 | container | start | mr-01a148ff-9275-71ab-a08e-91125366d737 | 2 |  |
| 08:44:45 | container | die | mr-01a148ff-9275-71ab-a08e-91125366d737 | 2 | 0 |
| 08:44:46 | container | destroy | mr-01a148ff-9275-71ab-a08e-91125366d737 | 2 |  |
| 08:44:47 | container | create | mr-01a14908-81ce-70be-bd5a-186769789da3 | 1 |  |
| 08:44:47 | container | extract-to-dir | mr-01a14908-81ce-70be-bd5a-186769789da3 | 1 |  |
| 08:44:48 | container | start | mr-01a14908-81ce-70be-bd5a-186769789da3 | 1 |  |
| 08:45:14 | container | die | mr-01a148ff-9266-76cf-bca2-740a4be859ce | 9 | 0 |
| 08:45:15 | container | destroy | mr-01a148ff-9266-76cf-bca2-740a4be859ce | 9 |  |
| 08:50:18 | container | create | mr-01a148ff-9266-76cf-bca2-740a4be859ce | 10 |  |
| 08:50:18 | container | extract-to-dir | mr-01a148ff-9266-76cf-bca2-740a4be859ce | 10 |  |
| 08:50:19 | container | start | mr-01a148ff-9266-76cf-bca2-740a4be859ce | 10 |  |
| 08:51:16 | container | kill | mr-01a148ff-9266-76cf-bca2-740a4be859ce | 10 |  |
| 08:51:16 | container | stop | mr-01a148ff-9266-76cf-bca2-740a4be859ce | 10 |  |
| 08:51:16 | container | die | mr-01a148ff-9266-76cf-bca2-740a4be859ce | 10 | 0 |
| 08:51:17 | container | destroy | mr-01a148ff-9266-76cf-bca2-740a4be859ce | 10 |  |

## Steps noted by the test

- `2026-10-17T08:34:30.971Z` (+2 s) **setup**: `{"instanceId": "d2it-1017083206f4", "image": "sha256:1964876d4628b238bbb9e96f4ecf6db7d1ba69c7d3154226bb50a54b0bfafa5a", "network": "orbit-mr-d2it-1017083206f4", "server": "http://172.18.0.1:45093"}`
- `2026-10-17T08:34:31.095Z` (+2 s) **(0) channel refusals**: `{"refusals": 24, "codes": ["UNAUTHENTICATED", "PARAMETER_REFUSED", "NAME_REFUSED", "IMAGE_REFUSED", "VOLUME_REFUSED", "SINGLE_CONTAINER_GUARD", "LIMIT_REFUSED", "NOT_FOUND", "NOT_MANAGED"]}`
- `2026-10-17T08:34:32.201Z` (+3 s) **(1) template**: `{"container": "mr-01a148ff-9266-76cf-bca2-740a4be859ce", "mounts": 3, "capDrop": ["ALL"], "nanoCpus": 500000000, "memory": 536870912, "pids": 512}`
- `2026-10-17T08:35:33.832Z` (+65 s) **(1) crash and retry**: `{"exitCode": 137, "finishedAt": "2026-10-17T08:35:01.978289054Z", "generation": 2, "pvcUid": "30b94e1e-6f9e-484c-a98d-a2e68fd9529f"}`
- `2026-10-17T08:35:34.076Z` (+65 s) **(2) seeded**: `{"files": "bb2e1338b609bdb88a28d54edc4e5da7066b489b4634ccefedada527fc5c3e8e  blob-1;0a277d99913de1e1455bef6ae45639680d57d5d7c99239dd3b2f150e02c38455  blob-2;61dc75a77e8c679745798fc6bd1eb0475f9333af65ca1b27a1f2c4e95cbecd03  note.txt;", "integrity": "ok", "rows": "5000|320000", "dump": "cf713fde6ca0a8f49ce017afd625242d400dcc1e69c93c908230fdb04c223d34"}`
- `2026-10-17T08:37:03.590Z` (+154 s) **(2) exited, not removed**: `{"exitCode": 0, "finishedAt": "2026-10-17T08:37:03.325025562Z", "poolReserved": {"cpu_millis_reserved": 1000, "memory_bytes_reserved": 1073741824, "pods_reserved": 2, "active_users_reserved": 2, "durable_bytes_reserved": 536870912}}`
- `2026-10-17T08:37:04.146Z` (+155 s) **(2) asleep**: `{"drainedAt": "2026-10-17T08:36:33.684Z", "sleptAt": "2026-10-17T08:37:03.693Z", "exitCode": 0, "poolReleased": {"cpu_millis_reserved": 500, "memory_bytes_reserved": 536870912, "pods_reserved": 1, "active_users_reserved": 1, "durable_bytes_reserved": 536870912}}`
- `2026-10-17T08:37:35.403Z` (+186 s) **(3) woken by a message**: `{"generation": 3, "wokeInSeconds": 31, "integrity": "ok", "sessionId": "de114f97-b26c-42c6-87fc-275343f27f15", "runClaimedAt": "2026-10-17T08:37:04.573Z", "statusAfterClaim": "FAILED", "assignedRunnerId": "01a148ff-9266-76cf-bca2-740a4be859ce"}`
- `2026-10-17T08:38:37.232Z` (+248 s) **(4) woken by a task**: `{"generation": 4, "task": "34hOIQ4UA8MGaG14vHol9", "sessionId": "5bb3c17b-e26e-595d-9034-033427cca2c2", "runClaimedAt": "2026-10-17T08:38:05.611Z", "statusAfterClaim": "RUNNING", "assignedRunnerId": "01a148ff-9266-76cf-bca2-740a4be859ce"}`
- `2026-10-17T08:40:07.582Z` (+338 s) **(5) woken by a scheduled wakeup**: `{"generation": 5, "sessionId": "a42cd81d-c9e0-40e0-8056-8058ce5ada6f", "runClaimedAt": "2026-10-17T08:39:36.884Z", "statusAfterClaim": "FAILED", "assignedRunnerId": "01a148ff-9266-76cf-bca2-740a4be859ce"}`
- `2026-10-17T08:41:07.988Z` (+399 s) **(6) concurrent wakes**: `{"wakes": 8, "generation": 6, "containers": 1, "maxAtOnce": 1}`
- `2026-10-17T08:41:10.433Z` (+401 s) **(7) everything stopped**: `{"container": "exited"}`
- `2026-10-17T08:41:42.645Z` (+433 s) **(7) recovered**: `{"generation": 7, "integrity": "ok", "rows": "5242|350976"}`
- `2026-10-17T08:42:12.617Z` (+463 s) **(8) manager stopped mid-wake**: `{"state": "STARTING", "podUid": null}`
- `2026-10-17T08:42:43.523Z` (+494 s) **(8) finished after the restart**: `{"generation": 8}`
- `2026-10-17T08:43:13.540Z` (+524 s) **(9) channel down**: `{"state": "PROVISIONING", "attempt": 1}`
- `2026-10-17T08:43:45.500Z` (+556 s) **(9) woken once the channel was back**: `{"generation": 9}`
- `2026-10-17T08:44:25.277Z` (+596 s) **(10) third runner waiting**: `{"reason": "MANAGED_RUNNER_CAPACITY_UNAVAILABLE", "poolReserved": {"cpu_millis_reserved": 1000, "memory_bytes_reserved": 1073741824, "pods_reserved": 2, "active_users_reserved": 2, "durable_bytes_reserved": 536870912}}`
- `2026-10-17T08:50:18.842Z` (+950 s) **(10) third runner started after a release**: `{"bobSleptAt": "2026-10-17T08:44:46.759Z", "liveWhenCarolWasCreated": 1, "carolReadyAt": "2026-10-17T08:50:18.808Z", "poolReserved": {"cpu_millis_reserved": 500, "memory_bytes_reserved": 536870912, "pods_reserved": 1, "active_users_reserved": 1, "durable_bytes_reserved": 805306368}}`
- `2026-10-17T08:51:18.004Z` (+1009 s) **(11) disk limit**: `{"eviction": "container 05efc5aa-80d4-45a3-9b2f-17df5165e843 is exited (exit 0; stopped: its volume held 346105301 bytes, over its 268435456-byte limit)", "refusal": "This runner's data volume is over its disk limit, so no instance is started on it. An operator has to free space on it or raise its limit; then it can be retried."}`
- `2026-10-17T08:51:18.010Z` (+1009 s) **inventory**: `{"mappings": 3, "maxContainersPerVolume": {"01a148ff-9266-76cf-bca2-740a4be859ce": 1, "01a148ff-9275-71ab-a08e-91125366d737": 1, "01a14908-81ce-70be-bd5a-186769789da3": 1}}`

## Final inventory: database mappings and Docker

- runner `01a148ff-9266-76cf-bca2-740a4be859ce`: FAILED, generation 11, volume `mr-data-01a148ff-9266-76cf-bca2-740a4be859ce`, container UID `None`
- runner `01a148ff-9275-71ab-a08e-91125366d737`: SLEEPING, generation 3, volume `mr-data-01a148ff-9275-71ab-a08e-91125366d737`, container UID `None`
- runner `01a14908-81ce-70be-bd5a-186769789da3`: READY, generation 1, volume `mr-data-01a14908-81ce-70be-bd5a-186769789da3`, container UID `cd1ff383-7841-4d9a-b9c9-72f8720c9e27`
- at most one container per volume at any sampled moment: `{"01a148ff-9266-76cf-bca2-740a4be859ce": 1, "01a148ff-9275-71ab-a08e-91125366d737": 1, "01a14908-81ce-70be-bd5a-186769789da3": 1}`
