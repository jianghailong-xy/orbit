# "Test web" in every CI run since the last green one

Every run of `.github/workflows/ci.yml` on main from run 2329 (`bcc89c7af`, the last green "Test web" named in the task) to run 2419, plus run 2420, which is the same workflow dispatched on `probe/main-web-tests-utc` at the fix commit. "JavaScript job" and "Test web" come from the Actions API. The vitest summary and the failing tests come from that job's own log. Read on 2026-10-09 at 12:00Z, when run 2419 was still running its other jobs.

92 runs (run 2329 to run 2420). "Test web" ran in 44: 3 success, 41 failure. In the others the run was cancelled, or an earlier step failed, before "Test web" started.

Failing tests, as the job logs name them:

- **F1**: `src/components/ProjectPanoramaHeader.test.tsx > the landing row, from a server that lists its jobs > makes the row a button that opens the list, and keeps it a line to read from an older server`

| Run | Commit | Ref (event) | JavaScript job | Test web | Vitest (Test web step) | Failing |
|---|---|---|---|---|---|---|
| [2329](https://github.com/jianghailong-xy/orbit/actions/runs/37742589901) | `bcc89c7af` | main (push) | completed/success | **success** | files 365 passed (365); tests 4680 passed (4680) | — |
| [2330](https://github.com/jianghailong-xy/orbit/actions/runs/37747462051) | `4d77d69b7` | main (push) | completed/success | **success** | files 365 passed (365); tests 4680 passed (4680) | — |
| [2331](https://github.com/jianghailong-xy/orbit/actions/runs/37750329759) | `d3ef58c75` | main (push) | completed/failure | **failure** | files 1 failed, 365 passed (366); tests 1 failed, 4693 passed (4694) | F1 |
| [2332](https://github.com/jianghailong-xy/orbit/actions/runs/37753162569) | `93ab20b8c` | main (push) | completed/failure | **failure** | files 1 failed, 365 passed (366); tests 1 failed, 4693 passed (4694) | F1 |
| [2333](https://github.com/jianghailong-xy/orbit/actions/runs/37755015586) | `075b7a6c8` | main (push) | completed/failure | **failure** | files 1 failed, 367 passed (368); tests 1 failed, 4752 passed (4753) | F1 |
| [2334](https://github.com/jianghailong-xy/orbit/actions/runs/37763915217) | `5cb9a5540` | main (push) | completed/failure | **failure** | files 1 failed, 367 passed (368); tests 1 failed, 4752 passed (4753) | F1 |
| [2335](https://github.com/jianghailong-xy/orbit/actions/runs/37765936755) | `6a58a9515` | main (push) | completed/failure | **failure** | files 1 failed, 367 passed (368); tests 1 failed, 4752 passed (4753) | F1 |
| [2336](https://github.com/jianghailong-xy/orbit/actions/runs/37772183469) | `f1020fc5e` | main (push) | completed/failure | **failure** | files 1 failed, 367 passed (368); tests 1 failed, 4752 passed (4753) | F1 |
| [2337](https://github.com/jianghailong-xy/orbit/actions/runs/37773762245) | `f7c90a1b7` | main (push) | completed/failure | **failure** | files 1 failed, 367 passed (368); tests 1 failed, 4753 passed (4754) | F1 |
| [2338](https://github.com/jianghailong-xy/orbit/actions/runs/37776645055) | `710c66e6d` | main (push) | completed/failure | **failure** | files 1 failed, 367 passed (368); tests 1 failed, 4753 passed (4754) | F1 |
| [2339](https://github.com/jianghailong-xy/orbit/actions/runs/37778972665) | `58a3889ff` | main (push) | completed/failure | **failure** | files 1 failed, 367 passed (368); tests 1 failed, 4758 passed (4759) | F1 |
| [2340](https://github.com/jianghailong-xy/orbit/actions/runs/37780701492) | `edfc0b712` | main (push) | completed/failure | **failure** | files 1 failed, 367 passed (368); tests 1 failed, 4758 passed (4759) | F1 |
| [2341](https://github.com/jianghailong-xy/orbit/actions/runs/37784064197) | `29f49af63` | main (push) | completed/failure | **failure** | files 1 failed, 367 passed (368); tests 1 failed, 4758 passed (4759) | F1 |
| [2342](https://github.com/jianghailong-xy/orbit/actions/runs/37788962943) | `0eaf40074` | main (push) | completed/failure | **failure** | files 1 failed, 367 passed (368); tests 1 failed, 4758 passed (4759) | F1 |
| [2343](https://github.com/jianghailong-xy/orbit/actions/runs/37792835160) | `4183583bb` | main (push) | completed/cancelled | **cancelled** | — | — |
| [2344](https://github.com/jianghailong-xy/orbit/actions/runs/37794151459) | `80a96ad97` | main (push) | completed/cancelled | **cancelled** | — | — |
| [2345](https://github.com/jianghailong-xy/orbit/actions/runs/37795903924) | `ed019aa49` | main (push) | completed/cancelled | **cancelled** | — | — |
| [2346](https://github.com/jianghailong-xy/orbit/actions/runs/37796809044) | `347e21da2` | main (push) | completed/cancelled | **cancelled** | — | — |
| [2347](https://github.com/jianghailong-xy/orbit/actions/runs/37798722593) | `e4481d6c9` | main (push) | completed/cancelled | **failure** | files 1 failed, 367 passed (368); tests 1 failed, 4758 passed (4759) | F1 |
| [2348](https://github.com/jianghailong-xy/orbit/actions/runs/37800341783) | `5c6f5661c` | main (push) | completed/cancelled | **cancelled** | — | — |
| [2349](https://github.com/jianghailong-xy/orbit/actions/runs/37801091521) | `721e48275` | main (push) | completed/failure | **failure** | files 1 failed, 367 passed (368); tests 1 failed, 4758 passed (4759) | F1 |
| [2350](https://github.com/jianghailong-xy/orbit/actions/runs/37807415205) | `b8bc76d1f` | main (push) | completed/cancelled | **cancelled** | — | — |
| [2351](https://github.com/jianghailong-xy/orbit/actions/runs/37808393969) | `ba16aba9d` | main (push) | completed/cancelled | **cancelled** | — | — |
| [2352](https://github.com/jianghailong-xy/orbit/actions/runs/37809208790) | `404c5ffce` | main (push) | completed/failure | **failure** | files 1 failed, 369 passed (370); tests 1 failed, 4784 passed (4785) | F1 |
| [2353](https://github.com/jianghailong-xy/orbit/actions/runs/37813797041) | `047f91076` | main (push) | completed/failure | **failure** | files 1 failed, 369 passed (370); tests 1 failed, 4784 passed (4785) | F1 |
| [2354](https://github.com/jianghailong-xy/orbit/actions/runs/37824404879) | `4181a90ec` | main (push) | completed/failure | **failure** | files 1 failed, 369 passed (370); tests 1 failed, 4784 passed (4785) | F1 |
| [2355](https://github.com/jianghailong-xy/orbit/actions/runs/37829978727) | `80dd4f134` | main (push) | completed/failure | **failure** | files 1 failed, 369 passed (370); tests 1 failed, 4784 passed (4785) | F1 |
| [2356](https://github.com/jianghailong-xy/orbit/actions/runs/37845110380) | `3369ee1e0` | main (push) | completed/failure | **failure** | files 1 failed, 369 passed (370); tests 1 failed, 4784 passed (4785) | F1 |
| [2357](https://github.com/jianghailong-xy/orbit/actions/runs/37849901355) | `19247ec50` | main (push) | completed/cancelled | **cancelled** | — | — |
| [2358](https://github.com/jianghailong-xy/orbit/actions/runs/37850566825) | `a043d82fd` | main (push) | completed/cancelled | **skipped** | — | — |
| [2359](https://github.com/jianghailong-xy/orbit/actions/runs/37850679742) | `7095932db` | main (push) | completed/failure | **failure** | files 1 failed, 369 passed (370); tests 1 failed, 4785 passed (4786) | F1 |
| [2360](https://github.com/jianghailong-xy/orbit/actions/runs/37852287612) | `b77990bd8` | main (push) | completed/failure | **failure** | files 1 failed, 369 passed (370); tests 1 failed, 4785 passed (4786) | F1 |
| [2361](https://github.com/jianghailong-xy/orbit/actions/runs/37854424972) | `8b0e0c4e2` | main (push) | completed/cancelled | **skipped** | — | — |
| [2362](https://github.com/jianghailong-xy/orbit/actions/runs/37854603361) | `b29d9a47a` | main (push) | none | **none** | — | — |
| [2363](https://github.com/jianghailong-xy/orbit/actions/runs/37854650796) | `bc790273c` | main (push) | completed/cancelled | **cancelled** | — | — |
| [2364](https://github.com/jianghailong-xy/orbit/actions/runs/37855089459) | `f759d743e` | main (push) | none | **none** | — | — |
| [2365](https://github.com/jianghailong-xy/orbit/actions/runs/37855144656) | `870e33a1f` | main (push) | completed/failure | **failure** | files 1 failed, 369 passed (370); tests 1 failed, 4785 passed (4786) | F1 |
| [2366](https://github.com/jianghailong-xy/orbit/actions/runs/37857181431) | `eb7a73bcc` | main (push) | completed/cancelled | **skipped** | — | — |
| [2367](https://github.com/jianghailong-xy/orbit/actions/runs/37857383937) | `a9575fb3b` | main (push) | completed/cancelled | **skipped** | — | — |
| [2368](https://github.com/jianghailong-xy/orbit/actions/runs/37857470326) | `18e8263b3` | main (push) | completed/cancelled | **cancelled** | — | — |
| [2369](https://github.com/jianghailong-xy/orbit/actions/runs/37858011877) | `3ced69192` | main (push) | completed/cancelled | **skipped** | — | — |
| [2370](https://github.com/jianghailong-xy/orbit/actions/runs/37858259832) | `4ee2420d7` | main (push) | none | **none** | — | — |
| [2371](https://github.com/jianghailong-xy/orbit/actions/runs/37858308802) | `5e17800a0` | main (push) | completed/failure | **skipped** | — | — |
| [2372](https://github.com/jianghailong-xy/orbit/actions/runs/37860107698) | `abf5b5577` | main (push) | completed/failure | **skipped** | — | — |
| [2373](https://github.com/jianghailong-xy/orbit/actions/runs/37861078567) | `66492ed12` | main (push) | completed/failure | **skipped** | — | — |
| [2374](https://github.com/jianghailong-xy/orbit/actions/runs/37861857022) | `e6238f318` | main (push) | completed/failure | **skipped** | — | — |
| [2375](https://github.com/jianghailong-xy/orbit/actions/runs/37863317652) | `f1837de8e` | main (push) | completed/failure | **skipped** | — | — |
| [2376](https://github.com/jianghailong-xy/orbit/actions/runs/37865871550) | `d91a0dd48` | main (push) | completed/failure | **skipped** | — | — |
| [2377](https://github.com/jianghailong-xy/orbit/actions/runs/37866442270) | `a5c99e27f` | main (push) | completed/failure | **failure** | files 1 failed, 369 passed (370); tests 1 failed, 4800 passed (4801) | F1 |
| [2378](https://github.com/jianghailong-xy/orbit/actions/runs/37868145512) | `a9af35f33` | main (push) | completed/cancelled | **skipped** | — | — |
| [2379](https://github.com/jianghailong-xy/orbit/actions/runs/37868297675) | `945098b11` | main (push) | completed/failure | **failure** | files 1 failed, 369 passed (370); tests 1 failed, 4800 passed (4801) | F1 |
| [2380](https://github.com/jianghailong-xy/orbit/actions/runs/37871092782) | `5b794d643` | main (push) | completed/failure | **failure** | files 1 failed, 369 passed (370); tests 1 failed, 4800 passed (4801) | F1 |
| [2381](https://github.com/jianghailong-xy/orbit/actions/runs/37873586128) | `953e6b588` | main (push) | completed/failure | **failure** | files 1 failed, 369 passed (370); tests 1 failed, 4800 passed (4801) | F1 |
| [2382](https://github.com/jianghailong-xy/orbit/actions/runs/37875105367) | `cb621c3ff` | main (push) | completed/cancelled | **cancelled** | — | — |
| [2383](https://github.com/jianghailong-xy/orbit/actions/runs/37875563377) | `f339640df` | main (push) | completed/failure | **failure** | files 1 failed, 370 passed (371); tests 1 failed, 4823 passed (4824) | F1 |
| [2384](https://github.com/jianghailong-xy/orbit/actions/runs/37879705568) | `391902756` | main (push) | completed/failure | **failure** | files 1 failed, 370 passed (371); tests 1 failed, 4823 passed (4824) | F1 |
| [2385](https://github.com/jianghailong-xy/orbit/actions/runs/37880833105) | `d55e9900b` | main (push) | completed/cancelled | **cancelled** | — | — |
| [2386](https://github.com/jianghailong-xy/orbit/actions/runs/37881713281) | `40fcb7b1e` | main (push) | completed/cancelled | **cancelled** | — | — |
| [2387](https://github.com/jianghailong-xy/orbit/actions/runs/37882557574) | `92bd81c79` | main (push) | completed/cancelled | **cancelled** | — | — |
| [2388](https://github.com/jianghailong-xy/orbit/actions/runs/37883397512) | `6f4956d12` | main (push) | none | **none** | — | — |
| [2389](https://github.com/jianghailong-xy/orbit/actions/runs/37883434674) | `f8fdf50f0` | main (push) | completed/cancelled | **cancelled** | — | — |
| [2390](https://github.com/jianghailong-xy/orbit/actions/runs/37884165446) | `2ed62feae` | main (push) | none | **none** | — | — |
| [2391](https://github.com/jianghailong-xy/orbit/actions/runs/37884224795) | `2a1568546` | main (push) | completed/cancelled | **skipped** | — | — |
| [2392](https://github.com/jianghailong-xy/orbit/actions/runs/37884528319) | `ce168845f` | main (push) | completed/cancelled | **skipped** | — | — |
| [2393](https://github.com/jianghailong-xy/orbit/actions/runs/37884688734) | `7f2b37c40` | main (push) | completed/cancelled | **skipped** | — | — |
| [2394](https://github.com/jianghailong-xy/orbit/actions/runs/37884929767) | `76d41066d` | main (push) | completed/cancelled | **cancelled** | — | — |
| [2395](https://github.com/jianghailong-xy/orbit/actions/runs/37885372897) | `2fc7fb909` | main (push) | completed/cancelled | **failure** | files 1 failed, 370 passed (371); tests 1 failed, 4845 passed (4846) | F1 |
| [2396](https://github.com/jianghailong-xy/orbit/actions/runs/37886333492) | `caea4729b` | main (push) | completed/failure | **failure** | files 1 failed, 370 passed (371); tests 1 failed, 4845 passed (4846) | F1 |
| [2397](https://github.com/jianghailong-xy/orbit/actions/runs/37891157653) | `8fcd5b3c7` | main (push) | completed/cancelled | **cancelled** | — | — |
| [2398](https://github.com/jianghailong-xy/orbit/actions/runs/37892052723) | `6c9cebd4d` | main (push) | completed/cancelled | **cancelled** | — | — |
| [2399](https://github.com/jianghailong-xy/orbit/actions/runs/37892852099) | `fce12bc2a` | main (push) | none | **none** | — | — |
| [2400](https://github.com/jianghailong-xy/orbit/actions/runs/37892901686) | `cbe6a6635` | main (push) | completed/failure | **failure** | files 1 failed, 373 passed (374); tests 1 failed, 4883 passed (4884) | F1 |
| [2401](https://github.com/jianghailong-xy/orbit/actions/runs/37894112750) | `a6e01fbc5` | main (push) | completed/cancelled | **cancelled** | — | — |
| [2402](https://github.com/jianghailong-xy/orbit/actions/runs/37895053362) | `19c760ae4` | main (push) | completed/failure | **failure** | files 1 failed, 373 passed (374); tests 1 failed, 4883 passed (4884) | F1 |
| [2403](https://github.com/jianghailong-xy/orbit/actions/runs/37900700887) | `f849377e3` | main (push) | completed/cancelled | **cancelled** | — | — |
| [2404](https://github.com/jianghailong-xy/orbit/actions/runs/37901196909) | `d98183765` | main (push) | completed/cancelled | **cancelled** | — | — |
| [2405](https://github.com/jianghailong-xy/orbit/actions/runs/37902080007) | `62b7009ca` | main (push) | completed/cancelled | **cancelled** | — | — |
| [2406](https://github.com/jianghailong-xy/orbit/actions/runs/37903168382) | `4085437ff` | main (push) | completed/cancelled | **skipped** | — | — |
| [2407](https://github.com/jianghailong-xy/orbit/actions/runs/37903526369) | `fadc587b0` | main (push) | completed/failure | **failure** | files 1 failed, 373 passed (374); tests 1 failed, 4883 passed (4884) | F1 |
| [2408](https://github.com/jianghailong-xy/orbit/actions/runs/37908172179) | `41637e3c5` | main (push) | completed/cancelled | **cancelled** | — | — |
| [2409](https://github.com/jianghailong-xy/orbit/actions/runs/37908738311) | `9414fa44c` | main (push) | completed/cancelled | **cancelled** | — | — |
| [2410](https://github.com/jianghailong-xy/orbit/actions/runs/37909502596) | `a74ecb43b` | main (push) | completed/failure | **failure** | files 1 failed, 374 passed (375); tests 1 failed, 4891 passed (4892) | F1 |
| [2411](https://github.com/jianghailong-xy/orbit/actions/runs/37910999850) | `c627594db` | main (push) | completed/cancelled | **cancelled** | — | — |
| [2412](https://github.com/jianghailong-xy/orbit/actions/runs/37912102775) | `c5a903d34` | main (push) | completed/cancelled | **cancelled** | — | — |
| [2413](https://github.com/jianghailong-xy/orbit/actions/runs/37912668528) | `112083d42` | main (push) | completed/failure | **failure** | files 1 failed, 375 passed (376); tests 1 failed, 4901 passed (4902) | F1 |
| [2414](https://github.com/jianghailong-xy/orbit/actions/runs/37914460783) | `0a887da2c` | main (push) | completed/failure | **failure** | files 1 failed, 375 passed (376); tests 1 failed, 4904 passed (4905) | F1 |
| [2415](https://github.com/jianghailong-xy/orbit/actions/runs/37917191098) | `e9f1d5024` | main (push) | completed/failure | **failure** | files 1 failed, 375 passed (376); tests 1 failed, 4904 passed (4905) | F1 |
| [2416](https://github.com/jianghailong-xy/orbit/actions/runs/37918456001) | `51c5c8eeb` | main (push) | completed/failure | **failure** | files 1 failed, 375 passed (376); tests 1 failed, 4904 passed (4905) | F1 |
| [2417](https://github.com/jianghailong-xy/orbit/actions/runs/37919961608) | `3efa0cbbd` | main (push) | completed/failure | **failure** | files 1 failed, 375 passed (376); tests 1 failed, 4904 passed (4905) | F1 |
| [2418](https://github.com/jianghailong-xy/orbit/actions/runs/37922447583) | `002059e44` | main (push) | completed/failure | **failure** | files 1 failed, 375 passed (376); tests 1 failed, 4904 passed (4905) | F1 |
| [2419](https://github.com/jianghailong-xy/orbit/actions/runs/37924682927) | `c8a431304` | main (push) | completed/failure | **failure** | files 1 failed, 375 passed (376); tests 1 failed, 4904 passed (4905) | F1 |
| [2420](https://github.com/jianghailong-xy/orbit/actions/runs/37925405725) | `b9b52a924` | probe/main-web-tests-utc (workflow_dispatch) | completed/success | **success** | files 376 passed (376); tests 4905 passed (4905) | — |
