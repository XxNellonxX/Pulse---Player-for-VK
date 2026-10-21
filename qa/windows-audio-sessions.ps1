param([int]$AppProcessId = 0)
# Read-only WASAPI inspection. Does not play audio or alter a device, volume or mute.
$ErrorActionPreference = 'Stop'
if (-not ('VkPlayerAudioDiagnostics' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class AudioEnumeratorClass {}
[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int flow, uint states, out IDeviceCollection devices);
    [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IDevice device);
}
[ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IDeviceCollection {
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int Item(uint index, out IDevice device);
}
[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IDevice {
    [PreserveSig] int Activate(ref Guid iid, uint context, IntPtr parameters, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
    [PreserveSig] int OpenPropertyStore(uint access, out IntPtr store);
    [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
}
[ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface ISessionManager {
    [PreserveSig] int GetAudioSessionControl(IntPtr guid, uint flags, out IntPtr control);
    [PreserveSig] int GetSimpleAudioVolume(IntPtr guid, uint flags, out IntPtr volume);
    [PreserveSig] int GetSessionEnumerator(out ISessionEnumerator sessions);
}
[ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface ISessionEnumerator {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int GetSession(int index, out ISessionControl control);
}
[ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface ISessionControl {
    [PreserveSig] int GetState(out int state);
    [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    [PreserveSig] int SetDisplayName(IntPtr name, IntPtr context);
    [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
    [PreserveSig] int SetIconPath(IntPtr path, IntPtr context);
    [PreserveSig] int GetGroupingParam(out Guid grouping);
    [PreserveSig] int SetGroupingParam(IntPtr grouping, IntPtr context);
    [PreserveSig] int RegisterAudioSessionNotification(IntPtr callback);
    [PreserveSig] int UnregisterAudioSessionNotification(IntPtr callback);
    [PreserveSig] int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetProcessId(out uint processId);
}
[ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IReadOnlySessionVolume {
    // Placeholders preserve the COM vtable order. The diagnostic never invokes these slots.
    [PreserveSig] int ReservedSetVolumeSlot(float volume, IntPtr context);
    [PreserveSig] int GetMasterVolume(out float volume);
    [PreserveSig] int ReservedSetMuteSlot([MarshalAs(UnmanagedType.Bool)] bool muted, IntPtr context);
    [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool muted);
}
public class AudioSessionSnapshot {
    public string endpoint { get; set; }
    public uint processId { get; set; }
    public string state { get; set; }
    public string displayName { get; set; }
    public string iconPath { get; set; }
    public string grouping { get; set; }
    public bool volumeControlAvailable { get; set; }
    public float? masterVolume { get; set; }
    public bool? muted { get; set; }
}
public static class VkPlayerAudioDiagnostics {
    public static AudioSessionSnapshot[] Read() {
        var result = new List<AudioSessionSnapshot>();
        var enumerator = (IDeviceEnumerator)new AudioEnumeratorClass();
        IDeviceCollection devices;
        Marshal.ThrowExceptionForHR(enumerator.EnumAudioEndpoints(0, 1, out devices));
        uint deviceCount; Marshal.ThrowExceptionForHR(devices.GetCount(out deviceCount));
        for (uint d = 0; d < deviceCount; d++) {
            IDevice device; Marshal.ThrowExceptionForHR(devices.Item(d, out device));
            string endpoint; Marshal.ThrowExceptionForHR(device.GetId(out endpoint));
            var managerId = typeof(ISessionManager).GUID; object raw;
            int hr = device.Activate(ref managerId, 23, IntPtr.Zero, out raw);
            if (hr < 0) continue;
            var manager = (ISessionManager)raw;
            ISessionEnumerator sessions; Marshal.ThrowExceptionForHR(manager.GetSessionEnumerator(out sessions));
            int count; Marshal.ThrowExceptionForHR(sessions.GetCount(out count));
            for (int i = 0; i < count; i++) {
                ISessionControl session; if (sessions.GetSession(i, out session) < 0) continue;
                uint processId; int state; string name, icon; Guid grouping;
                session.GetProcessId(out processId); session.GetState(out state);
                session.GetDisplayName(out name); session.GetIconPath(out icon); session.GetGroupingParam(out grouping);
                bool volumeAvailable = false; float? volume = null; bool? muted = null;
                // QueryInterface for the existing stream's ISimpleAudioVolume; read only.
                try {
                    var sessionVolume = session as IReadOnlySessionVolume;
                    if (sessionVolume != null) {
                        float actualVolume; bool actualMute;
                        if (sessionVolume.GetMasterVolume(out actualVolume) >= 0 && sessionVolume.GetMute(out actualMute) >= 0) {
                            volumeAvailable = true; volume = actualVolume; muted = actualMute;
                        }
                    }
                } catch (COMException) { }
                result.Add(new AudioSessionSnapshot { endpoint=endpoint, processId=processId,
                    state=state == 1 ? "active" : state == 2 ? "expired" : "inactive",
                    displayName=name, iconPath=icon, grouping=grouping.ToString(),
                    volumeControlAvailable=volumeAvailable, masterVolume=volume, muted=muted });
                Marshal.ReleaseComObject(session);
            }
            Marshal.ReleaseComObject(sessions); Marshal.ReleaseComObject(manager); Marshal.ReleaseComObject(device);
        }
        Marshal.ReleaseComObject(devices); Marshal.ReleaseComObject(enumerator);
        return result.ToArray();
    }
}
'@
}
$processes = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name)
if ($AppProcessId -eq 0) {
    $AppProcessId = ($processes | Where-Object Name -eq 'vk-player.exe' | Select-Object -First 1).ProcessId
}
$owned = [System.Collections.Generic.HashSet[uint32]]::new()
if ($AppProcessId) { [void]$owned.Add([uint32]$AppProcessId) }
do {
    $before = $owned.Count
    foreach ($process in $processes) {
        if ($owned.Contains([uint32]$process.ParentProcessId)) { [void]$owned.Add([uint32]$process.ProcessId) }
    }
} while ($owned.Count -ne $before)
$sessions = @([VkPlayerAudioDiagnostics]::Read() | ForEach-Object {
    $session = $_
    $process = $processes | Where-Object ProcessId -eq $session.processId | Select-Object -First 1
    [pscustomobject]@{ processId=$session.processId; processName=$process.Name;
        belongsToApp=$owned.Contains([uint32]$session.processId); state=$session.state;
        displayName=$session.displayName; iconPath=$session.iconPath; grouping=$session.grouping;
        volumeControlAvailable=$session.volumeControlAvailable; masterVolume=$session.masterVolume; muted=$session.muted;
        endpoint=$session.endpoint }
})
[pscustomobject]@{ appProcessId=$AppProcessId; appProcesses=@($processes | Where-Object { $owned.Contains([uint32]$_.ProcessId) }); sessions=$sessions } | ConvertTo-Json -Depth 5
