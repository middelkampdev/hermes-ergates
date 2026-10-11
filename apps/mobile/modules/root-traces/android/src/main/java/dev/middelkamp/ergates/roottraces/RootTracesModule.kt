package dev.middelkamp.ergates.roottraces

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

/**
 * Looks for the `su` binary a rooted Android phone carries. Every path here is
 * absent on a stock phone (user builds ship no `su`), so finding one is a strong
 * sign; finding none proves nothing (Magisk can hide its files). ADR-041 in
 * docs/08-decision-log.md lists the source for each path. Directories such as
 * /sbin or /debug_ramdisk are not checked on their own: they exist on many
 * phones that are not rooted.
 */
class RootTracesModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("RootTraces")

    AsyncFunction("findRootTracesAsync") {
      TRACE_PATHS.filter(::exists)
    }
  }

  private companion object {
    val TRACE_PATHS = listOf(
      // Magisk before Android 11 puts its binaries, su included, in /sbin.
      "/sbin/su",
      // Classic su installs, and the directories on Android's default PATH.
      "/system/bin/su",
      "/system/xbin/su",
      "/system_ext/bin/su",
      "/vendor/bin/su",
      "/su/bin/su",
      "/data/local/su",
      "/data/local/bin/su",
      "/data/local/xbin/su"
    )

    /** A path the app may not look at counts as absent, so the check never fails start-up. */
    fun exists(path: String): Boolean = runCatching { File(path).exists() }.getOrDefault(false)
  }
}
