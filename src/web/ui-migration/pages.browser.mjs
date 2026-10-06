import { test, expect } from './harness.mjs';
import { taskScenario, shareScenario, projectsScenario, wikiScenario, settingsScenario, profileScenario } from './page-scenarios.mjs';
import { sessionScenarios } from './session-scenarios.mjs';

for (const [name, scenario] of Object.entries({ task: taskScenario, share: shareScenario, projects: projectsScenario, wiki: wikiScenario, settings: settingsScenario, profile: profileScenario, session: sessionScenarios })) {
  test(name, async ({ evidence }) => scenario(evidence));
}
