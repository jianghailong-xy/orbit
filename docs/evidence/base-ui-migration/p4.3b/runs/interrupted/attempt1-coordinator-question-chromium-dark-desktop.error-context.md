# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: p43b.browser.mjs >> P4.3b project decision cards >> a coordinator question: answering in one’s own words, refused
- Location: ui-migration/p43b.browser.mjs:446:3

# Error details

```
Test timeout of 90000ms exceeded.
```

```
Error: expect(page).toHaveScreenshot(expected) failed

Timeout: 15000ms
  Timeout 15000ms exceeded.

  Snapshot: p43b-question-typed.png

Call log:
  - Expect "toHaveScreenshot(p43b-question-typed.png)" with timeout 15000ms
    - generating new stable screenshot expectation
  - taking page screenshot
    - disabled all CSS animations
  - waiting for fonts to load...
  - Timeout 15000ms exceeded.

```

# Page snapshot

```yaml
- generic [ref=e4]:
  - complementary [ref=e5]:
    - generic [ref=e6]:
      - generic [ref=e14]: Orbit
      - button "Collapse sidebar" [ref=e15] [cursor=pointer]:
        - img "menu-fold" [ref=e16]
    - generic [ref=e19]:
      - generic [ref=e20]:
        - link "Projects Ctrl P" [ref=e21] [cursor=pointer]:
          - generic [ref=e28]: Projects
          - generic "Open Projects with Ctrl P" [ref=e29]: Ctrl P
        - link "Tasks" [ref=e30] [cursor=pointer]
        - link "Wiki" [ref=e37] [cursor=pointer]
        - link "Infrastructure" [ref=e42] [cursor=pointer]
      - generic [ref=e49]:
        - generic [ref=e50] [cursor=pointer]:
          - generic [ref=e51]: Workspaces
          - generic [ref=e52]: "1"
          - img "caret-down" [ref=e53]
          - button "Edit" [ref=e56]
        - generic [ref=e57] [cursor=pointer]:
          - generic [ref=e62]:
            - generic [ref=e63]: Orbit baseline
            - generic [aria-hidden] [ref=e64]: ·
            - generic "Baseline runner" [ref=e65]
          - generic "Open workspace with Ctrl 1" [ref=e66]: Ctrl 1
        - status [ref=e67]
      - generic [ref=e69]:
        - generic [ref=e70] [cursor=pointer]:
          - generic [ref=e71]: Projects
          - generic [ref=e72]: "1"
          - img "caret-down" [ref=e73]
        - generic [ref=e76] [cursor=pointer]: Orbit UI migration
    - button "Account menu, Baseline Reviewer" [ref=e81] [cursor=pointer]:
      - img "user" [ref=e83]
      - generic [ref=e86]: Baseline Reviewer
    - separator [ref=e87]
  - main [ref=e88]:
    - generic [ref=e90]:
      - link "← Projects" [ref=e91] [cursor=pointer]:
        - /url: /projects
      - generic [ref=e92]:
        - heading "Orbit UI migration" [level=2] [ref=e93]
        - generic [ref=e94]:
          - generic [ref=e95]: Open
          - generic [ref=e96]: 3 tasks
          - button "Record Orbit UI migration as done" [ref=e97] [cursor=pointer]:
            - generic [ref=e98]: Record as done
          - button "Record Orbit UI migration as cancelled" [ref=e99] [cursor=pointer]:
            - generic [ref=e100]: Record as cancelled
          - button "Share" [ref=e101] [cursor=pointer]
          - button "Copy link" [ref=e107] [cursor=pointer]
          - button "More project actions" [ref=e113] [cursor=pointer]
          - button "Delete Orbit UI migration" [ref=e118] [cursor=pointer]:
            - generic [ref=e123]: Delete project
      - region "Open items" [ref=e125]:
        - generic [ref=e126]:
          - generic [ref=e127]: Open items
          - generic [ref=e128]: 1 need you · 0 with the coordinator · oldest first
        - generic [ref=e129]: Needs you
        - list [ref=e130]:
          - listitem [ref=e131]:
            - generic [ref=e133]:
              - generic "Which batch lands first?" [ref=e134]
              - generic "Blocks 2 tasks" [ref=e135]
            - generic [ref=e136]:
              - text: You
              - time [ref=e137]: waiting 40m
      - generic [ref=e140]:
        - generic [ref=e141]:
          - generic [ref=e142]: The coordinator has a question
          - generic "Orbit filed this question on behalf of the conversation coordinating this project. It is not something an agent turn wrote into this page." [ref=e143]: FROM COORDINATOR
        - generic [ref=e144]:
          - paragraph [ref=e146]: P4.3a and P4.3b both change the project page. Both are ready to land, and the second one will have to merge the first. Which should land first?
          - generic [ref=e147] [cursor=pointer]:
            - radio "The lists and toolbars firstRecommended The graph batch merges them afterwards." [checked] [ref=e148]
            - generic [ref=e149]:
              - text: The lists and toolbars firstRecommended
              - generic [ref=e150]: The graph batch merges them afterwards.
          - generic [ref=e151] [cursor=pointer]:
            - radio "The graph and cards first" [ref=e152]
            - generic [ref=e153]: The graph and cards first
          - generic [ref=e154] [cursor=pointer]:
            - radio "Other — say it in my own words" [ref=e155]
            - generic [ref=e156]: Other — say it in my own words
          - textbox "Add a note (optional)" [active] [ref=e157]: Land the lists first, then rebase the graph batch and run its comparison again on the new tip.
          - paragraph [ref=e158]: Blocks 2 tasks
        - generic [ref=e159]:
          - button "Send answer" [ref=e160] [cursor=pointer]
          - generic [ref=e161]: asked 40m ago
      - generic [ref=e162]:
        - region "Work overview" [ref=e163]:
          - generic [ref=e164]:
            - heading "Work overview" [level=5] [ref=e165]
            - generic [ref=e166]: 3 tasks · 2 dependencies
          - generic [ref=e167]:
            - generic [ref=e168]:
              - generic [ref=e169]: Running
              - generic [ref=e172]: "0"
              - generic [ref=e173]: task work in progress
            - generic [ref=e174]:
              - generic [ref=e175]: Ready
              - generic [ref=e178]: "1"
              - generic [ref=e179]: can start now
            - generic [ref=e180]:
              - generic [ref=e181]: Waiting
              - generic [ref=e184]: "1"
              - generic [ref=e185]: waiting on dependencies
            - generic [ref=e186]:
              - generic [ref=e187]: Awaiting verification
              - generic [ref=e190]: "0"
              - generic [ref=e191]: verifier must conclude
            - generic [ref=e192]:
              - generic [ref=e193]: Done
              - generic [ref=e196]: "1"
              - generic [ref=e197]: 33% complete
            - generic [ref=e198]:
              - generic [ref=e199]: Failed
              - generic [ref=e202]: "0"
              - generic [ref=e203]: coordinated continuation
            - generic [ref=e204]:
              - generic [ref=e205]: Cancelled
              - generic [ref=e208]: "0"
              - generic [ref=e209]: closed without completion
          - 'img "Task status: 0 running, 1 ready, 1 waiting, 0 awaiting verification, 1 done, 0 failed, 0 cancelled" [ref=e211]':
            - generic "Ready 1" [ref=e212]
            - generic "Waiting 1" [ref=e213]
            - generic "Done 1" [ref=e214]
        - region "Coordinator" [ref=e217]:
          - generic [ref=e218]:
            - generic [ref=e219]: Coordinator
            - 'generic "Coordinator status: Not started" [ref=e220]': Not started
          - paragraph [ref=e222]: This conversation is where you and it decide what runs next — and where every judgment this project needs is answered.
          - generic [ref=e223]:
            - generic [ref=e224]:
              - generic [ref=e225]:
                - generic [ref=e226]: Opens in
                - generic [ref=e227]: Orbit baseline
              - button "Change" [ref=e230] [cursor=pointer]
            - paragraph [ref=e232]: Permanent — a coordinator cannot be moved to another workspace later.
          - button "Start coordinator" [ref=e234] [cursor=pointer]
      - region "How it runs" [ref=e237]:
        - generic [ref=e238]:
          - generic [ref=e239]: How it runs
          - generic [ref=e240]: applies from the next task
        - strong [ref=e244]: Automatic Off
        - generic [ref=e245]:
          - generic [ref=e246]:
            - generic [ref=e247]: Execution
            - generic [ref=e248]:
              - generic [ref=e249]: Tasks land on
              - radiogroup "Tasks land on" [ref=e251]:
                - generic [ref=e252] [cursor=pointer]:
                  - 'radio "A project branch · project/2zwQZ… Recommended when tasks depend on each other: they land here first and are checked together." [ref=e253]'
                  - radio [aria-hidden] [ref=e254]
                  - generic [ref=e255]:
                    - text: A project branch ·
                    - code [ref=e256]: project/2zwQZ…
                    - generic [ref=e257]: "Recommended when tasks depend on each other: they land here first and are checked together."
                - generic [ref=e258] [cursor=pointer]:
                  - radio "Directly into main For a single task or an urgent fix. Every merge into main asks you." [ref=e259]
                  - radio [aria-hidden] [ref=e260]
                  - generic [ref=e261]:
                    - text: Directly into main
                    - generic [ref=e262]: For a single task or an urgent fix. Every merge into main asks you.
            - generic [ref=e263]:
              - generic [ref=e264]: Automatic
              - generic [ref=e265]:
                - generic [ref=e266]:
                  - switch "Automatic" [ref=e267] [cursor=pointer]
                  - checkbox [aria-hidden] [ref=e269]
                  - generic [ref=e270]: "Off"
                - generic [ref=e271]: "The coordinator runs it for you: it decides when each task is done, handles conflicts and failed checks, and merges the branch into main once the merge check passes — with a receipt you can revert. The criteria and anything irreversible stay yours."
            - generic [ref=e272]:
              - generic [ref=e273]: At most
              - generic [ref=e274]:
                - generic [ref=e275]:
                  - spinbutton "At most" [ref=e276]: "2"
                  - generic:
                    - button "Increase Value" [ref=e277] [cursor=pointer]
                    - button "Decrease Value" [ref=e281] [cursor=pointer]
                - generic [ref=e285]: tasks at a time
          - generic [ref=e286]:
            - generic [ref=e287]: Integration
            - generic [ref=e288]:
              - generic [ref=e289]: Merge check
              - generic [ref=e290]:
                - textbox "Merge check" [ref=e291]:
                  - /placeholder: No check — work lands once it rebases cleanly
                - generic [ref=e292]: Runs on the combined tree before anything lands — on the project branch and again before main.
            - generic [ref=e293]:
              - generic [ref=e294]: Escalate after
              - generic [ref=e295]:
                - combobox "Escalate after" [ref=e297] [cursor=pointer]:
                  - generic [ref=e298]: 1 hour
                - textbox [aria-hidden] [ref=e302]: "3600"
                - generic [ref=e303]: Items the coordinator hasn’t handled by then come to you.
        - generic [ref=e304]:
          - button "Save" [disabled] [ref=e305]
          - button "Pause project" [ref=e307] [cursor=pointer]
        - generic [ref=e309]: Stops new tasks, wake-ups and merges into main. Running tasks finish.
      - region [ref=e311]:
        - heading "Goal" [level=5] [ref=e318]
        - paragraph [ref=e321]: Preserve the familiar interface while moving to owned components.
      - generic [ref=e323]:
        - generic [ref=e324]:
          - heading "Task graph" [level=4] [ref=e325]
          - generic "Prerequisite → dependent · boxes are parent tasks" [ref=e326]
        - generic [ref=e327]:
          - button "Open project task graph full screen" [ref=e328] [cursor=pointer]:
            - img "fullscreen" [ref=e329]
          - application [ref=e332]:
            - generic [ref=e334]:
              - generic:
                - generic:
                  - img:
                    - group "Edge from settled:2zwQZ2hd93IvLb59t6p5l to 2zwQZ2hd93IvLb59t6tUG"
                  - img:
                    - group "Edge from 2zwQZ2hd93IvLb59t6tUG to 2zwQZ2hd93IvLb59t6tUW"
                  - img:
                    - group "Edge from settled:2zwQZ2hd93IvLb59t6p5l to 2zwQZ2hd93IvLb59t6tUm"
                  - img:
                    - group "Edge from settled:2zwQZ2hd93IvLb59t6p5l to 2zwQZ2hd93IvLb59t6p5m"
                  - img:
                    - group "Edge from 2zwQZ2hd93IvLb59t6tUW to 2zwQZ2hd93IvLb59t6p5n"
                  - img:
                    - group "Edge from 2zwQZ2hd93IvLb59t6p5m to 2zwQZ2hd93IvLb59t6p5n"
                  - img:
                    - group "Edge from 2zwQZ2hd93IvLb59t6tUm to 2zwQZ2hd93IvLb59t6p5n"
                  - img:
                    - group "Edge from settled:2zwQZ2hd93IvLb59t6p5l to 2zwQZ2hd93IvLb59t6tVY"
                  - img:
                    - group "Edge from 2zwQZ2hd93IvLb59t6tVY to 2zwQZ2hd93IvLb59t6tVo"
                - generic:
                  - group [ref=e335]:
                    - link "Decision cards, Running, 2 subtasks" [ref=e337] [cursor=pointer]:
                      - /url: /projects/2zwQZ2hd93IvLb59t6p9d/tasks/2zwQZ2hd93IvLb59t6tUW
                      - generic [ref=e338]: Decision cards
                      - generic [ref=e339]:
                        - img "loading" [ref=e340]
                        - text: Running
                  - group [ref=e343]:
                    - button "2 done, 2 tasks folded" [ref=e345] [cursor=pointer]:
                      - generic [ref=e346]: 2 done
                      - generic [ref=e350]: Finished · click to open
                  - group [ref=e351]:
                    - button "Shared overlays, 4 tasks folded" [ref=e353] [cursor=pointer]:
                      - generic [ref=e354]:
                        - generic [ref=e355]: Shared overlays
                        - generic [ref=e356]: ×4
                      - generic [ref=e361]:
                        - text: 2 done
                        - generic [ref=e362]: · 1 running
                        - generic [ref=e363]: · 1 open
                  - group [ref=e364]:
                    - button "Compare one page, 4 instances, 8 tasks folded" [ref=e366] [cursor=pointer]:
                      - generic [ref=e367]:
                        - generic [ref=e368]: Compare one page
                        - generic [ref=e369]: ×8
                      - generic [ref=e375]:
                        - text: 5 done
                        - generic [ref=e376]: · 1 running
                        - generic [ref=e377]: · 1 failed
                        - generic [ref=e378]: · 1 open
                  - group [ref=e379]:
                    - link "Capture browser baselines, Open, Ready to run" [ref=e381] [cursor=pointer]:
                      - /url: /projects/2zwQZ2hd93IvLb59t6p9d/tasks/2zwQZ2hd93IvLb59t6p5m
                      - generic [ref=e382]: Capture browser baselines
                      - generic [ref=e383]: Ready to run
                  - group [ref=e384]:
                    - link "Migrate shared controls, Open, Waiting on 3" [ref=e386] [cursor=pointer]:
                      - /url: /projects/2zwQZ2hd93IvLb59t6p9d/tasks/2zwQZ2hd93IvLb59t6p5n
                      - generic [ref=e387]: Migrate shared controls
                      - generic [ref=e388]: Waiting on 3
                  - group [ref=e389]:
                    - link "Fix the toolbar overlap, Failed" [ref=e391] [cursor=pointer]:
                      - /url: /projects/2zwQZ2hd93IvLb59t6p9d/tasks/2zwQZ2hd93IvLb59t6tVY
                      - generic [ref=e392]: Fix the toolbar overlap
                      - generic [ref=e393]: Failed
                  - group [ref=e394]:
                    - link "Register the drift, Open, Waiting on 1" [ref=e396] [cursor=pointer]:
                      - /url: /projects/2zwQZ2hd93IvLb59t6p9d/tasks/2zwQZ2hd93IvLb59t6tVo
                      - generic [ref=e397]: Register the drift
                      - generic [ref=e398]: Waiting on 1
                  - group [ref=e399]:
                    - link "Evidence decision card, Done" [ref=e401] [cursor=pointer]:
                      - /url: /projects/2zwQZ2hd93IvLb59t6p9d/tasks/2zwQZ2hd93IvLb59t6tUX
                      - generic [ref=e402]: Evidence decision card
                      - generic [ref=e403]: Done
                  - group [ref=e404]:
                    - link "Owner confirmation card, Running" [ref=e406] [cursor=pointer]:
                      - /url: /projects/2zwQZ2hd93IvLb59t6p9d/tasks/2zwQZ2hd93IvLb59t6tUY
                      - generic [ref=e407]: Owner confirmation card
                      - generic [ref=e408]: Running
            - generic [ref=e409]: 18 tasks · 1 ready to run · 3 done · dashed marks are folded
            - generic "Task graph controls" [ref=e410]:
              - button "Zoom in task graph" [ref=e411] [cursor=pointer]
              - button "Zoom out task graph" [ref=e414] [cursor=pointer]
              - button "Fit whole project in view" [ref=e417] [cursor=pointer]
      - region "Chain progress" [ref=e422]:
        - 'img "Chain progress: step 2 of 3, 1 complete, 2 remaining" [ref=e423]'
        - generic [ref=e428]:
          - generic [ref=e429]: Step 2 / 3
          - text: · Capture browser baselines
      - region [ref=e431]:
        - heading "Run queue 1 ready · sorted by work unblocked" [level=4] [ref=e432]:
          - generic [ref=e433]: Run queue
          - generic "1 ready · sorted by work unblocked" [ref=e434]
        - list [ref=e435]:
          - listitem [ref=e436]:
            - generic [ref=e437]:
              - generic "Capture browser baselines" [ref=e438]
              - generic [ref=e439]: Prerequisites complete
            - generic [ref=e443]: Unblocks 1 task
            - button "Run Capture browser baselines" [ref=e444] [cursor=pointer]:
              - generic [ref=e450]: Run
        - text: Ready tasks can start now.
      - region [ref=e452]:
        - heading "Acceptance criteria" [level=2] [ref=e454]
        - generic [ref=e455]:
          - generic [ref=e456]: 2 criteria stated. Whether one is met is read off the work filed under it; nothing in Orbit judges the criteria themselves.
          - list [ref=e457]:
            - listitem [ref=e458]:
              - generic [ref=e459]: "1"
              - generic [ref=e460]:
                - text: Representative browser scenes can be reproduced.
                - generic [ref=e461]: Not met by its work
            - listitem [ref=e463]:
              - generic [ref=e464]: "2"
              - generic [ref=e465]:
                - text: The dependency graph opens, folds and navigates as before.
                - generic [ref=e466]:
                  - generic [ref=e467]: Met by its work
                  - generic [ref=e468]: · no merge receipt either way
          - generic [ref=e469]: Task completion is a process measure, and nothing evaluates these criteria — a project can finish every task and still meet none of the conditions it was stated for. What a row says about a criterion is computed from the work filed under it, not a judgment anybody made.
      - generic [ref=e471]:
        - heading "Instructions" [level=5] [ref=e472]
        - paragraph [ref=e474]: Reuse design variables, themes, and existing business semantics.
      - generic [ref=e476]:
        - generic [ref=e477]:
          - heading "Tasks" [level=4] [ref=e478]
          - button "New task" [ref=e479] [cursor=pointer]
        - generic [ref=e481]:
          - generic [ref=e482]:
            - strong [ref=e484]: Ready · can start now
            - generic [ref=e485]: 1 task
          - list [ref=e487]:
            - listitem [ref=e488] [cursor=pointer]:
              - generic [ref=e489]:
                - generic [ref=e492]:
                  - heading "Capture browser baselines OPEN Ready · can start now blocks 1" [level=4] [ref=e493]:
                    - generic [ref=e494]:
                      - link "Capture browser baselines" [ref=e497]:
                        - /url: /projects/2zwQZ2hd93IvLb59t6p9d/tasks/2zwQZ2hd93IvLb59t6p5m
                      - generic [ref=e498]: OPEN
                      - generic [ref=e499]: Ready · can start now
                      - generic [ref=e500]: blocks 1
                  - generic [ref=e502]: The representative pages retain their layout and keyboard behavior.
                - generic [ref=e503]: 0 subtasks
        - generic [ref=e504]:
          - generic [ref=e505]:
            - strong [ref=e507]: Blocked · topology level 2
            - generic [ref=e508]: 1 task
          - list [ref=e510]:
            - listitem [ref=e511] [cursor=pointer]:
              - generic [ref=e512]:
                - generic [ref=e515]:
                  - heading "Migrate shared controls OPEN Blocked waits 1" [level=4] [ref=e516]:
                    - generic [ref=e517]:
                      - link "Migrate shared controls" [ref=e520]:
                        - /url: /projects/2zwQZ2hd93IvLb59t6p9d/tasks/2zwQZ2hd93IvLb59t6p5n
                      - generic [ref=e521]: OPEN
                      - generic [ref=e522]: Blocked
                      - generic [ref=e523]: waits 1
                  - generic [ref=e525]: The representative pages retain their layout and keyboard behavior.
                - generic [ref=e526]: 0 subtasks
        - generic [ref=e527]:
          - generic [ref=e528]:
            - generic [ref=e529]: Done / Cancelled
            - generic [ref=e530]: 1 task
          - list [ref=e532]:
            - listitem [ref=e533] [cursor=pointer]:
              - generic [ref=e534]:
                - generic [ref=e537]:
                  - heading "Inventory existing components DONE blocks 1" [level=4] [ref=e538]:
                    - generic [ref=e539]:
                      - link "Inventory existing components" [ref=e542]:
                        - /url: /projects/2zwQZ2hd93IvLb59t6p9d/tasks/2zwQZ2hd93IvLb59t6p5l
                      - generic [ref=e543]: DONE
                      - generic [ref=e544]: blocks 1
                  - generic [ref=e546]: The representative pages retain their layout and keyboard behavior.
                - generic [ref=e547]: 0 subtasks
      - generic [ref=e549]:
        - generic [ref=e551]:
          - generic [ref=e552]: Cross-project crossings
          - generic [ref=e553]: 2 waiting
        - list [ref=e556]:
          - listitem [ref=e557]:
            - generic [ref=e558]:
              - generic "Crossing PENDING" [ref=e559]: PENDING
              - strong [ref=e561]: Waiting for your answer
              - generic "Crossing kind MOVE_TASK" [ref=e562]: MOVE_TASK
            - generic [ref=e563]:
              - generic [ref=e564]: "Task to move:"
              - strong [ref=e566]: Document the Orbit components
              - code [ref=e568]:
                - text: 2zwQZ2hd93IvLb59t6tYO
                - button "Copy" [ref=e570] [cursor=pointer]:
                  - img "copy" [ref=e571]
            - generic [ref=e574]:
              - generic [ref=e575]:
                - strong [ref=e577]: Orbit UI migration
                - code [ref=e579]:
                  - text: 2zwQZ2hd93IvLb59t6p9d
                  - button "Copy" [ref=e581] [cursor=pointer]:
                    - img "copy" [ref=e582]
                - generic "Project status OPEN" [ref=e585]: OPEN
              - text: →
              - generic [ref=e586]:
                - strong [ref=e588]: Release documentation
                - code [ref=e590]:
                  - text: 2zwQZ2hd93IvLb59t6p9e
                  - button "Copy" [ref=e592] [cursor=pointer]:
                    - img "copy" [ref=e593]
                - generic "Project status DONE" [ref=e596]: DONE
            - text: the task stays in its project until you answer, and confirming moves it
            - generic [ref=e597]:
              - generic [ref=e598]: "Target criterion requested:"
              - text: Every shared component has a usage note.
              - code [ref=e600]: usage-notes
            - generic [ref=e601]:
              - generic [ref=e602]: "Source criterion it serves now:"
              - text: Representative browser scenes can be reproduced.
              - code [ref=e604]: visual-baseline
              - text: Confirming the move withdraws this declaration.
            - generic [ref=e605]: "Reason given: The release documentation project owns the usage notes."
            - generic [ref=e607]:
              - button "Approve…" [ref=e609] [cursor=pointer]
              - button "Refuse…" [ref=e612] [cursor=pointer]
          - listitem [ref=e614]:
            - generic [ref=e615]:
              - generic "Crossing PENDING" [ref=e616]: PENDING
              - strong [ref=e618]: Waiting for your answer
              - generic "Crossing kind FILE_TASK" [ref=e619]: FILE_TASK
            - generic [ref=e620]: Write the migration notes
            - generic [ref=e621]:
              - generic [ref=e622]:
                - strong [ref=e624]: Orbit UI migration
                - code [ref=e626]:
                  - text: 2zwQZ2hd93IvLb59t6p9d
                  - button "Copy" [ref=e628] [cursor=pointer]:
                    - img "copy" [ref=e629]
                - generic "Project status OPEN" [ref=e632]: OPEN
              - text: →
              - generic [ref=e633]:
                - strong [ref=e635]: Release documentation
                - code [ref=e637]:
                  - text: 2zwQZ2hd93IvLb59t6p9e
                  - button "Copy" [ref=e639] [cursor=pointer]:
                    - img "copy" [ref=e640]
                - generic "Project status DONE" [ref=e643]: DONE
            - text: the work is not filed anywhere until you answer
            - generic [ref=e644]: "Reason given: Notes for the people who upgrade."
            - generic [ref=e646]:
              - button "Approve…" [ref=e648] [cursor=pointer]
              - button "Refuse…" [ref=e651] [cursor=pointer]
          - listitem [ref=e653]:
            - generic [ref=e654]:
              - generic "Crossing APPLIED" [ref=e655]: APPLIED
              - strong [ref=e657]: Applied
              - generic "Crossing kind FILE_TASK" [ref=e658]: FILE_TASK
            - generic [ref=e659]: Publish the component guide
            - generic [ref=e660]:
              - generic [ref=e661]:
                - strong [ref=e663]: Orbit UI migration
                - code [ref=e665]:
                  - text: 2zwQZ2hd93IvLb59t6p9d
                  - button "Copy" [ref=e667] [cursor=pointer]:
                    - img "copy" [ref=e668]
                - generic "Project status OPEN" [ref=e671]: OPEN
              - text: →
              - generic [ref=e672]:
                - strong [ref=e674]: Release documentation
                - code [ref=e676]:
                  - text: 2zwQZ2hd93IvLb59t6p9e
                  - button "Copy" [ref=e678] [cursor=pointer]:
                    - img "copy" [ref=e679]
                - generic "Project status DONE" [ref=e682]: DONE
            - text: this answer has been spent; it authorises nothing further
          - listitem [ref=e683]:
            - generic [ref=e684]:
              - generic "Crossing DENIED" [ref=e685]: DENIED
              - strong [ref=e687]: Refused
              - generic "Crossing kind FILE_TASK" [ref=e688]: FILE_TASK
            - generic [ref=e689]: Rewrite the changelog
            - generic [ref=e690]:
              - generic [ref=e691]:
                - strong [ref=e693]: Orbit UI migration
                - code [ref=e695]:
                  - text: 2zwQZ2hd93IvLb59t6p9d
                  - button "Copy" [ref=e697] [cursor=pointer]:
                    - img "copy" [ref=e698]
                - generic "Project status OPEN" [ref=e701]: OPEN
              - text: →
              - generic [ref=e702]:
                - strong [ref=e704]: Release documentation
                - code [ref=e706]:
                  - text: 2zwQZ2hd93IvLb59t6p9e
                  - button "Copy" [ref=e708] [cursor=pointer]:
                    - img "copy" [ref=e709]
                - generic "Project status DONE" [ref=e712]: DONE
            - text: refusing is final for this crossing — file the work yourself if you change your mind
```

# Test source

```ts
  1  | import { test as base, expect } from '@playwright/test';
  2  | import { writeFileSync } from 'node:fs';
  3  | import { installFixtures, installFixedDate } from './fixtures.mjs';
  4  | 
  5  | export { expect };
  6  | export const test = base.extend({
  7  |   scenario: ['default', { option: true }],
  8  |   evidence: async ({ page, scenario }, use, testInfo) => {
  9  |     const theme = testInfo.project.use.colorScheme;
  10 |     await installFixedDate(page);
  11 |     const api = await installFixtures(page, { theme, scenario });
  12 |     const pageErrors = [];
  13 |     page.on('pageerror', (error) => pageErrors.push(error.message));
  14 |     const measurements = { project: testInfo.project.name, test: testInfo.title, browser: page.context().browser().version(), captures: [], timings: [] };
  15 |     async function measure(name, operation) {
  16 |       const start = performance.now();
  17 |       const result = await operation();
  18 |       await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  19 |       const end = performance.now();
  20 |       measurements.timings.push({ name, elapsedMs: end - start });
  21 |       return result;
  22 |     }
  23 |     async function capture(name, selectors = {}) {
  24 |       await page.evaluate(() => document.fonts.ready);
  25 |       for (const selector of Object.values(selectors)) {
  26 |         const locator = typeof selector === 'string' ? page.locator(selector).first() : selector;
  27 |         await expect(locator).toBeVisible();
  28 |         // Visibility alone accepts opacity:0 during an overlay's prepare phase.
  29 |         await expect.poll(() => locator.evaluate((el) => {
  30 |           for (let node = el; node; node = node.parentElement) {
  31 |             if (Number(getComputedStyle(node).opacity) < 1) return false;
  32 |           }
  33 |           return true;
  34 |         }), { message: `${name}: selected content has finished fading in` }).toBe(true);
  35 |       }
  36 |       await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  37 |       // Screenshot assertion waits for two identical frames. No visual masking or custom CSS.
> 38 |       await expect(page).toHaveScreenshot(`${name}.png`);
     |                          ^ Error: expect(page).toHaveScreenshot(expected) failed
  39 |       const styles = await page.evaluate(() => {
  40 |         const properties = ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'color', 'backgroundColor', 'border', 'borderTop', 'borderRight', 'borderBottom', 'borderLeft', 'borderRadius', 'boxShadow', 'outline', 'outlineOffset', 'padding', 'gap', 'display', 'position', 'zIndex', 'transitionDuration', 'animationDuration'];
  41 |         const controls = [...document.querySelectorAll('h1,h2,h3,button,input,textarea,[role="button"],[role="combobox"],[role="switch"],[role="dialog"],[role="menu"],.toast-card')].filter((el) => el.getBoundingClientRect().width && el.getBoundingClientRect().height && getComputedStyle(el).visibility !== 'hidden');
  42 |         const canvas = document.createElement('canvas');
  43 |         const context = canvas.getContext('2d');
  44 |         context.font = `14px ${getComputedStyle(document.body).fontFamily}`;
  45 |         const glyphProbe = { text: 'Orbit baseline 0123 — 中文输入', font: context.font, width: context.measureText('Orbit baseline 0123 — 中文输入').width };
  46 |         return {
  47 |           glyphProbe,
  48 |           viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scale: visualViewport?.scale, touch: navigator.maxTouchPoints },
  49 |           navigation: performance.getEntriesByType('navigation').map((entry) => entry.toJSON()),
  50 |           paint: performance.getEntriesByType('paint').map((entry) => entry.toJSON()),
  51 |           theme: document.documentElement.dataset.theme,
  52 |           tokens: Object.fromEntries(['--bg-base', '--bg-raised', '--text-1', '--text-2', '--border', '--brand'].map((name) => [name, getComputedStyle(document.documentElement).getPropertyValue(name).trim()])),
  53 |           documentWidth: document.documentElement.scrollWidth,
  54 |           graphGeometry: [...document.querySelectorAll('[data-testid="project-dependency-graph"],.pdg-task')].map((el) => ({ label: el.matches('.pdg-task') ? el.textContent : 'graph', ...el.getBoundingClientRect().toJSON() })),
  55 |           media: Object.fromEntries([600,640,960].map((width) => [width, matchMedia(`(max-width: ${width}px)`).matches])),
  56 |           controls: controls.map((el) => { const rect = el.getBoundingClientRect(), style = getComputedStyle(el); return {
  57 |             tag: el.tagName, role: el.getAttribute('role'), label: el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.textContent?.trim().slice(0, 100),
  58 |             disabled: el.matches(':disabled'), focused: el === document.activeElement, hovered: el.matches(':hover'),
  59 |             rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
  60 |             style: Object.fromEntries(properties.map((key) => [key, style[key]])),
  61 |           }; }),
  62 |         };
  63 |       });
  64 |       if (testInfo.project.use.browserName === 'chromium') {
  65 |         const cdp = await page.context().newCDPSession(page);
  66 |         await cdp.send('DOM.enable');
  67 |         await cdp.send('CSS.enable');
  68 |         const { root } = await cdp.send('DOM.getDocument');
  69 |         const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '.tdp-title, h1, .chat-assistant p' });
  70 |         if (nodeId) styles.renderedFonts = (await cdp.send('CSS.getPlatformFontsForNode', { nodeId })).fonts;
  71 |         await cdp.detach();
  72 |       }
  73 |       expect(styles.viewport.dpr).toBe(1);
  74 |       expect(styles.viewport.scale).toBe(1);
  75 |       expect(styles.viewport.width).toBe(page.viewportSize().width);
  76 |       expect(styles.theme).toBe(theme);
  77 |       const selected = {};
  78 |       for (const [label, selector] of Object.entries(selectors)) {
  79 |         const locator = typeof selector === 'string' ? page.locator(selector).first() : selector;
  80 |         await expect(locator).toBeVisible();
  81 |         selected[label] = await locator.evaluate((el) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return { width: r.width, height: r.height, fontFamily: s.fontFamily, fontSize: s.fontSize, fontWeight: s.fontWeight, lineHeight: s.lineHeight, color: s.color, background: s.backgroundColor, border: s.border, radius: s.borderRadius, shadow: s.boxShadow }; });
  82 |       }
  83 |       measurements.captures.push({ name, ...styles, selected });
  84 |     }
  85 |     try {
  86 |       await use({ page, expect, capture, measure, api, measurements });
  87 |       api.assertHandled();
  88 |       expect(pageErrors, 'No unhandled errors in the real application').toEqual([]);
  89 |     } finally {
  90 |       const path = testInfo.outputPath('evidence.json');
  91 |       writeFileSync(path, JSON.stringify({ ...measurements, requests: api.requests, unhandled: api.unhandled, pageErrors }, null, 2) + '\n');
  92 |       await testInfo.attach('computed-styles-and-timings', { path, contentType: 'application/json' });
  93 |     }
  94 |   },
  95 | });
  96 | 
```