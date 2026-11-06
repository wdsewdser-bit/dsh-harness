param(
  [string]$Build,
  [string]$Run,
  [string]$Dll
)

# Job-object launcher for the offline runner.
#
#   -Build <file>          compile the job API once into an assembly
#   -Run <spec.json> -Dll <file>
#                          join a new job object first, then start the suite command. Every descendant inherits the job,
#                          whatever its pid, however quickly it starts and however quickly its parent exits.
#
# The launcher prints the suite output untouched (the child inherits these handles) and reports on stderr:
#   ##JOB-ORPHANS## [{"pid":..,"command":..}]   the suite left processes behind; they were terminated
#   ##JOB-UNAVAILABLE## <message>               the job object could not be used: the run must fail, not pass quietly

$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.Runtime.InteropServices;

public static class JobApi
{
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimit
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimit
    {
        public BasicLimit BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    // Every import sets SetLastError, so GetLastWin32Error() always describes this call and not an earlier one.
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length,
        out uint returned);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    public static IntPtr Create()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) return IntPtr.Zero;
        ExtendedLimit limit = new ExtendedLimit();
        limit.BasicLimitInformation.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, no BREAKAWAY_OK
        int size = Marshal.SizeOf(typeof(ExtendedLimit));
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(limit, buffer, false);
            if (!SetInformationJobObject(job, 9, buffer, (uint)size)) return IntPtr.Zero;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
        return job;
    }

    public static bool Assign(IntPtr job)
    {
        return AssignProcessToJobObject(job, GetCurrentProcess());
    }

    private static bool failNextQuery;
    private static int capacityFloor;

    /** Test seam: make the next query fail the way a broken job handle would. */
    public static void FailNextQuery()
    {
        failNextQuery = true;
    }

    /** Test seam: start the buffer so small that a real query has to grow it. */
    public static void SetInitialCapacity(int size)
    {
        capacityFloor = size;
    }

    public static long[] Pids(IntPtr job)
    {
        if (failNextQuery)
        {
            failNextQuery = false;
            throw new System.ComponentModel.Win32Exception(5);
        }
        int capacity = capacityFloor > 0 ? capacityFloor : 1024;
        for (int attempt = 0; attempt < 6; attempt++)
        {
            int size = 8 + 8 * capacity;
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try
            {
                uint returned;
                if (QueryInformationJobObject(job, 3, buffer, (uint)size, out returned))
                {
                    int count = Marshal.ReadInt32(buffer, 4);
                    long[] pids = new long[count];
                    for (int i = 0; i < count; i++) pids[i] = Marshal.ReadInt64(buffer, 8 + 8 * i);
                    return pids;
                }
                int error = Marshal.GetLastWin32Error();
                if (error == 234) { capacity *= 4; continue; } // ERROR_MORE_DATA: grow the buffer and ask again
                // Anything else is not "no processes": an unreadable job must fail the suite.
                throw new System.ComponentModel.Win32Exception(error);
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }
        throw new System.InvalidOperationException("the job process list did not fit the buffer");
    }

    private static bool failNextPump;

    /** Test seam: make the next output pump fail, so an incomplete capture is visible end to end. */
    public static void FailNextPump()
    {
        failNextPump = true;
    }

    /** Copy a suite stream to a file, flushing every chunk so an interrupted run keeps what it produced. */
    private static void Pump(System.IO.Stream source, string file)
    {
        if (failNextPump)
        {
            failNextPump = false;
            throw new System.IO.IOException("injected pump failure");
        }
        using (System.IO.FileStream sink = new System.IO.FileStream(file, System.IO.FileMode.Create,
            System.IO.FileAccess.Write, System.IO.FileShare.ReadWrite))
        {
            byte[] buffer = new byte[8192];
            while (true)
            {
                int read = source.Read(buffer, 0, buffer.Length);
                if (read <= 0) break;
                sink.Write(buffer, 0, read);
                sink.Flush();
            }
        }
    }

    public static System.Threading.Tasks.Task PumpAsync(System.IO.Stream source, string file)
    {
        return System.Threading.Tasks.Task.Run(() => Pump(source, file));
    }

    public static bool Terminate(IntPtr job)
    {
        return TerminateJobObject(job, 1);
    }
}
'@

if ($Build) {
  Add-Type -TypeDefinition $source -Language CSharp -OutputAssembly $Build -ErrorAction Stop
  if (-not (Test-Path -LiteralPath $Build)) { throw 'the job api assembly was not written' }
  exit 0
}

try {
  if (-not (Test-Path -LiteralPath $Dll)) { throw 'the job api assembly is missing: ' + $Dll }
  Add-Type -Path $Dll -ErrorAction Stop
  $spec = Get-Content -LiteralPath $Run -Raw | ConvertFrom-Json
  if ($env:DSH_TEST_JOB_SMALL_BUFFER) { [JobApi]::SetInitialCapacity(1) }
  if ($env:DSH_TEST_JOB_PUMP_FAULT) { [JobApi]::FailNextPump() }
  $job = [JobApi]::Create()
  if ($job -eq [IntPtr]::Zero) { throw 'CreateJobObject with KILL_ON_JOB_CLOSE failed' }
  if (-not [JobApi]::Assign($job)) { throw 'AssignProcessToJobObject failed for the launcher' }

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = [string]$spec.command
  $psi.Arguments = [string]$spec.commandLine
  $psi.WorkingDirectory = [string]$spec.cwd
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  # The launcher has no console of its own, so the child's output is copied to files the runner reads back.
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $child = [System.Diagnostics.Process]::Start($psi)
  if ($null -eq $child) { throw 'the suite process could not be started' }
  $pumpOut = [JobApi]::PumpAsync($child.StandardOutput.BaseStream, [string]$spec.stdout)
  $pumpErr = [JobApi]::PumpAsync($child.StandardError.BaseStream, [string]$spec.stderr)
  $child.WaitForExit()
  $code = $child.ExitCode
  # A descendant that inherited the handles keeps the copy open forever: the wait is bounded and the leftover check
  # always runs, whatever the copy is doing.
  $drained = $false
  try { $drained = [System.Threading.Tasks.Task]::WaitAll(@($pumpOut, $pumpErr), 2000) } catch { $drained = $false }
  $pumpFault = ''
  foreach ($pump in @($pumpOut, $pumpErr)) {
    if ($pump.IsFaulted -and $pumpFault -eq '') { $pumpFault = $pump.Exception.GetBaseException().Message }
  }

  # A process that is still shutting down is not a leftover: give the job a moment to drain before deciding.
  $self = [int64]$PID
  if ($env:DSH_TEST_JOB_QUERY_FAULT) { [JobApi]::FailNextQuery() }
  $left = @()
  for ($round = 0; $round -lt 4; $round++) {
    $left = @([JobApi]::Pids($job) | Where-Object { [int64]$_ -ne $self })
    if ($left.Count -eq 0) { break }
    Start-Sleep -Milliseconds 400
  }
  # The last sleep may have outlived what it saw: decide on a fresh query, never on the stale list.
  $left = @([JobApi]::Pids($job) | Where-Object { [int64]$_ -ne $self })
  if ($left.Count -gt 0) {
    $entries = @()
    foreach ($p in $left) {
      $command = ''
      try {
        $row = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId=' + $p) -ErrorAction Stop
        if ($null -ne $row) { $command = [string]$row.CommandLine }
      } catch { }
      $entries += '{"pid":' + $p + ',"command":' + (ConvertTo-Json -InputObject $command -Compress) + '}'
    }
    [Console]::Error.WriteLine('##JOB-ORPHANS## [' + ($entries -join ',') + ']')
    [Console]::Error.Flush()
    [void][JobApi]::Terminate($job)
    Start-Sleep -Milliseconds 500
    exit 97
  }
  # No leftovers, so the only reason the capture can be short is a faulted pump or a stream that never closed.
  if (-not $drained -or $pumpFault -ne '') {
    $detail = 'the suite output was not captured completely'
    if ($pumpFault -ne '') { $detail = $detail + ': ' + $pumpFault } else { $detail = $detail + ': the stream stayed open' }
    [Console]::Error.WriteLine('##OUTPUT-INCOMPLETE## ' + $detail)
    [Console]::Error.Flush()
    exit 96
  }
  exit $code
} catch {
  [Console]::Error.WriteLine('##JOB-UNAVAILABLE## ' + $_.Exception.Message)
  [Console]::Error.Flush()
  exit 98
}
