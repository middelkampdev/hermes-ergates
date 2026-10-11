import Darwin
import ExpoModulesCore

/// Looks for files a jailbreak leaves on an iPhone. Every path here is absent on
/// a stock iPhone, so finding one is a strong sign; finding none proves nothing
/// (a jailbreak can hide its files). ADR-041 in docs/08-decision-log.md lists
/// the source for each path.
public class RootTracesModule: Module {
  public func definition() -> ModuleDefinition {
    Name("RootTraces")

    AsyncFunction("findRootTracesAsync") { () -> [String] in
      return RootTracesModule.tracePaths.filter(RootTracesModule.exists)
    }
  }

  static let tracePaths = [
    // Rootless jailbreaks (Dopamine, palera1n rootless): /var/jb is a symlink
    // to the jailbreak root under /private/preboot, whose exact path is random.
    "/var/jb",
    // Dopamine writes this marker at the jailbreak root when it bootstraps.
    "/var/jb/.installed_dopamine",
    // Procursus, the bootstrap rootless jailbreaks install, ships su here.
    "/var/jb/usr/bin/su",
    // Package managers: rootless builds install under /var/jb, rootful under /.
    "/var/jb/Applications/Sileo.app",
    "/var/jb/Applications/Zebra.app",
    "/Applications/Sileo.app",
    "/Applications/Zebra.app",
    // The tool bundle checkra1n mounts, and the one palera1n mounts.
    "/var/binpack",
    "/cores/binpack",
  ]

  /// `lstat` sees a symlink itself, so /var/jb counts even when the sandbox
  /// cannot follow it into the jailbreak root.
  static func exists(_ path: String) -> Bool {
    if FileManager.default.fileExists(atPath: path) {
      return true
    }
    var info = stat()
    return lstat(path, &info) == 0
  }
}
