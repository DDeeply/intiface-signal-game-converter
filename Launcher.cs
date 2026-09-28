using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

static class AppLauncher {
    [STAThread]
    static void Main() {
        string baseDir = AppDomain.CurrentDomain.BaseDirectory;
        
        string[] candidates = new string[] {
            Path.Combine(baseDir, "Intiface信号转换代理.exe"),
            Path.Combine(baseDir, "dist", "Intiface信号转换代理.exe"),
            @"C:\Users\15027\.gemini\antigravity\scratch\intiface-proxy\dist\Intiface信号转换代理.exe"
        };

        string targetExe = null;
        foreach (var p in candidates) {
            if (File.Exists(p)) { targetExe = p; break; }
        }

        if (targetExe == null) {
            MessageBox.Show("找不到后端核心文件: Intiface信号转换代理.exe", "错误", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }

        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName = targetExe;
        psi.WorkingDirectory = Path.GetDirectoryName(targetExe);
        psi.CreateNoWindow = true;
        psi.UseShellExecute = false;
        psi.WindowStyle = ProcessWindowStyle.Hidden;

        try {
            Process p = Process.Start(psi);
            if (p != null) {
                p.WaitForExit();
            }
        } catch (Exception ex) {
            MessageBox.Show("启动失败: " + ex.Message, "错误", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}
