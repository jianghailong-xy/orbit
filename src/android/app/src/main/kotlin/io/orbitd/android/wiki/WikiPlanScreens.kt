package io.orbitd.android.wiki

import androidx.compose.runtime.Composable
import io.orbitd.android.directory.DirectoryData
import io.orbitd.android.navigation.OrbitRoute

// STUB — replaced by the plan port (iOS WikiPlanScreen over WikiPlanView.swift).

/** WIKI_PLAN: route.wikiVersion = version shown (null = default). WIKI_PLAN_DOC: route.id = doc slug, route.wikiVersion.
 * WIKI_PLAN_SECTION: route.id = doc slug, route.wikiPart = 0-based section index, route.wikiVersion. */
@Composable internal fun WikiPlanScreen(store: WikiStore, route: OrbitRoute, data: DirectoryData, nav: WikiNav) {}
