using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

public sealed class ScreenNotesMainWindow : Form
{
    private readonly WebView2 view = new WebView2();
    private readonly Uri address;
    private readonly string profile;
    private readonly Label status = new Label();

    public ScreenNotesMainWindow(string url, string profileDirectory, string iconPath)
    {
        address = new Uri(url);
        profile = profileDirectory;
        Text = "屏幕笔记 · 笔记库";
        Icon = File.Exists(iconPath) ? new Icon(iconPath) : SystemIcons.Application;
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.White;
        Size = new Size(1280, 840);
        MinimumSize = new Size(820, 540);
        status.Dock = DockStyle.Fill;
        status.TextAlign = ContentAlignment.MiddleCenter;
        status.Text = "正在打开笔记库…";
        view.Dock = DockStyle.Fill;
        view.Visible = false;
        Controls.Add(status);
        Controls.Add(view);
        Shown += Initialize;
        SizeChanged += delegate {
            Padding = WindowState == FormWindowState.Maximized ? new Padding(0) : new Padding(5);
            if (WindowState != FormWindowState.Minimized) PublishWindowState();
        };
        Padding = new Padding(5);
    }

    private bool IsAppPage(string url)
    {
        Uri uri;
        return Uri.TryCreate(url, UriKind.Absolute, out uri) &&
            uri.GetLeftPart(UriPartial.Authority) == address.GetLeftPart(UriPartial.Authority);
    }

    private async void Initialize(object sender, EventArgs args)
    {
        try {
            var env = await CoreWebView2Environment.CreateAsync(null, profile);
            if (IsDisposed) return;
            await view.EnsureCoreWebView2Async(env);
            if (IsDisposed) return;
            var core = view.CoreWebView2;
            core.Settings.IsNonClientRegionSupportEnabled = true;
            core.NavigationStarting += (s, e) => { e.Cancel = !IsAppPage(e.Uri); };
            core.NewWindowRequested += (s, e) => { e.Handled = true; };
            core.WebMessageReceived += ReceiveWindowCommand;
            await core.AddScriptToExecuteOnDocumentCreatedAsync("window.__SCREEN_NOTES_DESKTOP__ = true;");
            if (IsDisposed) return;
            view.Source = address;
            view.Visible = true;
            status.Visible = false;
        } catch (Exception error) {
            if (IsDisposed) return;
            status.Text = "无法加载 Windows WebView2。请安装或修复 Microsoft Edge WebView2 Runtime 后重试。\n\n" + error.Message;
        }
    }

    private void ReceiveWindowCommand(object sender, CoreWebView2WebMessageReceivedEventArgs args)
    {
        if (!IsAppPage(args.Source)) return;
        switch (args.TryGetWebMessageAsString()) {
            case "window-state": PublishWindowState(); break;
            case "minimize": WindowState = FormWindowState.Minimized; break;
            case "maximize":
                WindowState = WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized;
                PublishWindowState();
                break;
            case "close":
                BeginInvoke((Action)Close);
                break;
        }
    }

    private void PublishWindowState()
    {
        if (!view.IsDisposed && view.CoreWebView2 != null && IsAppPage(view.CoreWebView2.Source)) {
            view.CoreWebView2.PostWebMessageAsString(WindowState == FormWindowState.Maximized ? "maximized" : "restored");
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect { public int Left, Top, Right, Bottom; }

    protected override void WndProc(ref Message message)
    {
        const int NcCalcSize = 0x0083;
        const int NcHitTest = 0x0084;
        if (message.Msg == NcCalcSize && message.WParam != IntPtr.Zero) {
            if (WindowState == FormWindowState.Maximized) {
                var area = Screen.FromHandle(Handle).WorkingArea;
                var rect = new Rect { Left = area.Left, Top = area.Top, Right = area.Right, Bottom = area.Bottom };
                Marshal.StructureToPtr(rect, message.LParam, false);
            }
            message.Result = IntPtr.Zero;
            return;
        }
        base.WndProc(ref message);
        if (message.Msg == NcHitTest && WindowState == FormWindowState.Normal && message.Result.ToInt32() == 1) {
            var packed = message.LParam.ToInt64();
            var point = PointToClient(new Point((short)packed, (short)(packed >> 16)));
            bool left = point.X < Padding.Left, right = point.X >= ClientSize.Width - Padding.Right;
            bool top = point.Y < Padding.Top, bottom = point.Y >= ClientSize.Height - Padding.Bottom;
            if (top) message.Result = (IntPtr)(left ? 13 : right ? 14 : 12);
            else if (bottom) message.Result = (IntPtr)(left ? 16 : right ? 17 : 15);
            else if (left || right) message.Result = (IntPtr)(left ? 10 : 11);
        }
    }
}
