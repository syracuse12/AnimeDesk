using System;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Windows.Forms;
using Microsoft.Win32;

internal static class Setup
{
    [STAThread]
    private static int Main(string[] args)
    {
        bool silent = args.Length == 1 && args[0] == "--silent";
        try
        {
            if (!Environment.Is64BitOperatingSystem) throw new InvalidOperationException("AnimeDesk requires 64-bit Windows 10 or later.");
            if (AppHost.Browser() == null) throw new InvalidOperationException("Microsoft Edge or Google Chrome is required before installation.");
            string root = AppHost.InstallDir;
            if (Directory.Exists(root) && !File.Exists(Path.Combine(root, AppHost.Marker)))
                throw new InvalidOperationException("The installation folder contains files that are not an AnimeDesk release.");
            bool owner;
            using (var mutex = new System.Threading.Mutex(true, @"Local\AnimeDesk-Distribution", out owner))
            {
                if (!owner) throw new InvalidOperationException("Close AnimeDesk before installing an update.");
                string stage = root + ".new-" + Guid.NewGuid().ToString("N");
                Directory.CreateDirectory(stage);
                try
                {
                    using (Stream payload = Assembly.GetExecutingAssembly().GetManifestResourceStream("AnimeDeskPayload"))
                    using (var archive = new ZipArchive(payload, ZipArchiveMode.Read))
                    {
                        foreach (ZipArchiveEntry entry in archive.Entries)
                        {
                            if (entry.FullName.EndsWith("/")) continue;
                            string target = Path.GetFullPath(Path.Combine(stage, entry.FullName.Replace('/', Path.DirectorySeparatorChar)));
                            if (!target.StartsWith(stage + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                                throw new InvalidDataException("The release archive has an invalid path.");
                            Directory.CreateDirectory(Path.GetDirectoryName(target));
                            entry.ExtractToFile(target, false);
                        }
                    }
                    if (!File.Exists(Path.Combine(stage, "AnimeDesk.exe")) ||
                        !File.Exists(Path.Combine(stage, "runtime", "node.exe")) ||
                        !File.Exists(Path.Combine(stage, "dist", "index.html")))
                        throw new InvalidDataException("The release archive is incomplete.");
                    File.WriteAllText(Path.Combine(stage, AppHost.Marker), "AnimeDesk distribution release\n");
                    if (Directory.Exists(root)) Directory.Delete(root, true);
                    Directory.Move(stage, root);
                }
                finally { if (Directory.Exists(stage)) Directory.Delete(stage, true); }

                string executable = Path.Combine(root, "AnimeDesk.exe");
                CreateShortcut(AppHost.DesktopLink, executable);
                CreateShortcut(AppHost.MenuLink, executable);
                using (RegistryKey key = Registry.CurrentUser.CreateSubKey(AppHost.UninstallKey))
                {
                    key.SetValue("DisplayName", "AnimeDesk");
                    key.SetValue("DisplayVersion", "0.2.4");
                    key.SetValue("Publisher", "AnimeDesk local build");
                    key.SetValue("InstallLocation", root);
                    key.SetValue("DisplayIcon", executable);
                    key.SetValue("UninstallString", "\"" + executable + "\" --uninstall");
                    key.SetValue("NoModify", 1, RegistryValueKind.DWord);
                    key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                }
            }
            if (!silent) MessageBox.Show("AnimeDesk was installed for this Windows user.", "AnimeDesk");
            return 0;
        }
        catch (Exception ex)
        {
            if (!silent) MessageBox.Show("Installation failed: " + ex.Message, "AnimeDesk", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    private static void CreateShortcut(string path, string executable)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path));
        Type type = Type.GetTypeFromProgID("WScript.Shell");
        dynamic shell = Activator.CreateInstance(type);
        dynamic shortcut = shell.CreateShortcut(path);
        shortcut.TargetPath = executable;
        shortcut.WorkingDirectory = Path.GetDirectoryName(executable);
        shortcut.Description = "AnimeDesk";
        shortcut.Save();
    }
}
