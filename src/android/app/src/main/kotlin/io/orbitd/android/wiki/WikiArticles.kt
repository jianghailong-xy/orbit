package io.orbitd.android.wiki

import androidx.compose.runtime.Composable
import io.orbitd.android.directory.DirectoryData
import io.orbitd.android.navigation.OrbitRoute

// STUB — replaced by the articles port (iOS WikiArticleScreen/WikiBrowseScreen/WikiIndexScreen over WikiArticleView.swift + WikiDocView.swift browse/index pages).

/** route.id = topic slug, route.wikiPart = part (0 = the topic article). */
@Composable internal fun WikiArticleScreen(store: WikiStore, route: OrbitRoute, nav: WikiNav) {}
@Composable internal fun WikiBrowseScreen(store: WikiStore, route: OrbitRoute, nav: WikiNav) {}
@Composable internal fun WikiIndexScreen(store: WikiStore, route: OrbitRoute, nav: WikiNav) {}
