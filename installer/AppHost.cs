using System;
using System.Diagnostics;
using System.IO;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

internal static class AppHost
{
    internal const string Product = "AnimeDesk";
    internal const string Marker = ".animedesk-release";
    internal static string InstallDir { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", Product); } }
    internal static string DesktopLink { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), Product + ".lnk"); } }
    internal static string MenuLink { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), Product + ".lnk"); } }
    internal static string UninstallKey { get { return @"Software\Microsoft\Windows\CurrentVersion\Uninstall\AnimeDesk"; } }

    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length > 0 && args[0] == "--uninstall") return BeginUninstall(args.Length > 1 && args[1] == "--silent");
        if (args.Length > 0 && args[0] == "--uninstall-worker") return Uninstall(args.Length > 1 && args[1] == "--silent");
        return Run();
    }

    internal static string Browser()
    {
        string[] names = {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Microsoft\Edge\Application\msedge.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Microsoft\Edge\Application\msedge.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Google\Chrome\Application\chrome.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Google\Chrome\Application\chrome.exe")
        };
        foreach (string name in names) if (File.Exists(name)) return name;
        return null;
    }

    private static int Run()
    {
        bool owner;
        using (var mutex = new Mutex(true, @"Local\AnimeDesk-Distribution", out owner))
        {
            if (!owner) { MessageBox.Show("AnimeDesk is already running.", Product); return 0; }
            string root = Path.GetDirectoryName(typeof(AppHost).Assembly.Location);
            string node = Path.Combine(root, "runtime", "node.exe");
            string server = Path.Combine(root, "server", "main.ts");
            string browser = Browser();
            if (!File.Exists(node) || !File.Exists(server) || !File.Exists(Path.Combine(root, "dist", "index.html")))
                return Error("Installation is incomplete. Reinstall AnimeDesk.");
            if (browser == null) return Error("Microsoft Edge or Google Chrome is required. Install a browser and reopen AnimeDesk.");

            var ready = new ManualResetEvent(false);
            string url = null;
            var start = new ProcessStartInfo(node, "\"" + server + "\"");
            start.WorkingDirectory = root;
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.RedirectStandardInput = true;
            start.RedirectStandardOutput = true;
            start.RedirectStandardError = true;
            start.EnvironmentVariables["ANIMEDESK_PROFILE"] = "distribution";
            start.EnvironmentVariables["ANIMEDESK_PORT"] = "0";
            using (var service = new Process())
            {
                service.StartInfo = start;
                service.OutputDataReceived += (sender, eventArgs) => {
                    if (eventArgs.Data == null) return;
                    Match match = Regex.Match(eventArgs.Data, @"service ready on http://127\.0\.0\.1:(\d+)");
                    if (match.Success) { url = "http://127.0.0.1:" + match.Groups[1].Value + "/"; ready.Set(); }
                };
                service.ErrorDataReceived += (sender, eventArgs) => { /* drain diagnostics; do not write user data */ };
                try
                {
                    service.Start();
                    service.BeginOutputReadLine();
                    service.BeginErrorReadLine();
                    if (!ready.WaitOne(20000) || service.HasExited) return Error("The local service could not start.");
                    string profile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AnimeDesk", "distribution-window");
                    Directory.CreateDirectory(profile);
                    var windowStart = new ProcessStartInfo(browser,
                        "--app=" + url + " --user-data-dir=\"" + profile + "\" --window-size=1280,860 --no-first-run --no-default-browser-check");
                    windowStart.UseShellExecute = false;
                    using (Process window = Process.Start(windowStart))
                    {
                        if (window == null) return Error("The application window could not start.");
                        while (!window.WaitForExit(500) && !service.HasExited) { }
                        if (service.HasExited && !window.HasExited) { try { window.Kill(); } catch { } }
                    }
                    return 0;
                }
                catch (Exception ex) { return Error("AnimeDesk could not launch: " + ex.Message); }
                finally
                {
                    if (!service.HasExited)
                    {
                        try { service.StandardInput.WriteLine("shutdown"); service.StandardInput.Flush(); } catch { }
                        if (!service.WaitForExit(5000)) { try { service.Kill(); } catch { } }
                    }
                    ready.Dispose();
                }
            }
        }
    }

    private static int BeginUninstall(bool silent)
    {
        bool owner;
        using (var mutex = new Mutex(true, @"Local\AnimeDesk-Distribution", out owner))
        {
            if (!owner) return Error("Close AnimeDesk before uninstalling it.");
            string copy = Path.Combine(Path.GetTempPath(), "AnimeDesk-Uninstall-" + Guid.NewGuid().ToString("N") + ".exe");
            File.Copy(typeof(AppHost).Assembly.Location, copy);
            var start = new ProcessStartInfo(copy, "--uninstall-worker" + (silent ? " --silent" : ""));
            start.UseShellExecute = false;
            Process.Start(start);
            return 0;
        }
    }

    private static int Uninstall(bool silent)
    {
        string root = InstallDir;
        if (!File.Exists(Path.Combine(root, Marker))) return Error("AnimeDesk installation marker was not found.");
        using (var mutex = new Mutex(false, @"Local\AnimeDesk-Distribution"))
        try
        {
            if (!mutex.WaitOne(5000)) return Error("Close AnimeDesk before uninstalling it.");
            // Leave the personal development profile untouched.
            if (File.Exists(DesktopLink)) File.Delete(DesktopLink);
            if (File.Exists(MenuLink)) File.Delete(MenuLink);
            Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false);
            Directory.Delete(root, true);
            string data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "AnimeDesk", "distribution");
            string profile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AnimeDesk", "distribution-window");
            if (Directory.Exists(data)) Directory.Delete(data, true);
            if (Directory.Exists(profile)) Directory.Delete(profile, true);
            string self = typeof(AppHost).Assembly.Location;
            string cleanup = Path.Combine(Path.GetTempPath(), "AnimeDesk-cleanup-" + Guid.NewGuid().ToString("N") + ".cmd");
            File.WriteAllText(cleanup, "@echo off\r\ntimeout /t 2 /nobreak >nul\r\ndel /f /q \"" + self + "\"\r\ndel /f /q \"%~f0\"\r\n");
            var command = new ProcessStartInfo("cmd.exe", "/c \"\"" + cleanup + "\"\"");
            command.CreateNoWindow = true;
            command.UseShellExecute = false;
            Process.Start(command);
            if (!silent) MessageBox.Show("AnimeDesk was uninstalled.", Product);
            return 0;
        }
        catch (Exception ex) { return Error("Uninstall failed: " + ex.Message); }
        finally { try { mutex.ReleaseMutex(); } catch { } }
    }

    private static int Error(string message) { MessageBox.Show(message, Product, MessageBoxButtons.OK, MessageBoxIcon.Error); return 1; }
}
