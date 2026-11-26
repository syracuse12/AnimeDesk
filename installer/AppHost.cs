using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Security.Cryptography.X509Certificates;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
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

    /// <summary>
    /// The Evergreen WebView2 runtime ships with Windows 10/11 via Edge, but it
    /// is not guaranteed. Its presence is recorded as a per-client version under
    /// EdgeUpdate, so that key is the cheapest honest check available.
    /// </summary>
    internal static bool RuntimeAvailable()
    {
        const string client = @"Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
        string[] machineRoots = { @"SOFTWARE\WOW6432Node\", @"SOFTWARE\" };
        foreach (string root in machineRoots)
        {
            using (RegistryKey key = Registry.LocalMachine.OpenSubKey(root + client))
            {
                if (key != null && key.GetValue("pv") != null) return true;
            }
        }
        using (RegistryKey user = Registry.CurrentUser.OpenSubKey(@"SOFTWARE\" + client))
        {
            if (user != null && user.GetValue("pv") != null) return true;
        }
        return false;
    }

    /// <summary>
    /// Installs the Evergreen runtime from Microsoft's bootstrapper when it is
    /// missing. A Windows 10/11 machine with Edge already has it; this covers
    /// stripped or server images instead of failing the install outright.
    /// </summary>
    internal static bool InstallRuntime(bool silent)
    {
        const string bootstrapper = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";
        string file = Path.Combine(Path.GetTempPath(), "AnimeDesk-WebView2-" + Guid.NewGuid().ToString("N") + ".exe");
        try
        {
            if (!silent && MessageBox.Show(
                "AnimeDesk needs the Microsoft Edge WebView2 runtime, which is not installed. Download and install it now?",
                Product, MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes)
                return false;
            using (var client = new WebClient())
            {
                client.Headers.Add("User-Agent", Product + "-Setup");
                client.DownloadFile(bootstrapper, file);
            }
            // Never run an unsigned download: the bootstrapper is Microsoft-signed.
            X509Certificate certificate = X509Certificate.CreateFromSignedFile(file);
            if (certificate.Subject.IndexOf("Microsoft Corporation", StringComparison.OrdinalIgnoreCase) < 0)
                throw new InvalidOperationException("The WebView2 installer was not signed by Microsoft.");
            var start = new ProcessStartInfo(file, "/silent /install");
            start.UseShellExecute = false;
            using (var process = Process.Start(start))
            {
                if (process == null || !process.WaitForExit(300000))
                {
                    try { if (process != null) process.Kill(); } catch { }
                    return false;
                }
                if (process.ExitCode != 0) return false;
            }
            return RuntimeAvailable();
        }
        catch
        {
            return false;
        }
        finally
        {
            try { if (File.Exists(file)) File.Delete(file); } catch { }
        }
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
            if (!File.Exists(node) || !File.Exists(server) || !File.Exists(Path.Combine(root, "dist", "index.html")))
                return Error("Installation is incomplete. Reinstall AnimeDesk.");
            if (!RuntimeAvailable())
                return Error("The Microsoft Edge WebView2 runtime is required. Install it from https://developer.microsoft.com/microsoft-edge/webview2/ and reopen AnimeDesk.");

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
                    int code = ShowWindow(url, profile);
                    if (code != 0) return code;
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

    /// <summary>
    /// Owns the window and its WebView2 surface. Returns 0 on a clean close and
    /// non-zero only when the surface itself could not be created.
    /// </summary>
    private static int ShowWindow(string url, string profile)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        int code = 0;
        using (var form = new Form())
        {
            form.Text = Product;
            form.Width = 1280;
            form.Height = 860;
            form.MinimumSize = new System.Drawing.Size(900, 600);
            form.StartPosition = FormStartPosition.CenterScreen;
            var web = new WebView2();
            web.Dock = DockStyle.Fill;
            form.Controls.Add(web);
            form.Load += async (sender, eventArgs) =>
            {
                try
                {
                    CoreWebView2Environment environment = await CoreWebView2Environment.CreateAsync(null, profile);
                    await web.EnsureCoreWebView2Async(environment);
                    web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                    web.CoreWebView2.Settings.IsStatusBarEnabled = false;
                    web.CoreWebView2.Navigate(url);
                }
                catch (Exception ex)
                {
                    MessageBox.Show("The application window could not start: " + ex.Message, Product, MessageBoxButtons.OK, MessageBoxIcon.Error);
                    code = 1;
                    form.Close();
                }
            };
            Application.Run(form);
        }
        return code;
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