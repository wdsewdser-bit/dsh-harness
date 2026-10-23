using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Threading;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

// Windows x64 NTFS scratch capability. Authorization belongs to the native controller.
public sealed class ScratchCapability : IDisposable {
  [StructLayout(LayoutKind.Sequential)] struct Unicode { public ushort Length, MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)] struct Attributes { public int Length; public IntPtr Root, Name; public uint Flags; public IntPtr Security, Quality; }
  [StructLayout(LayoutKind.Sequential)] struct Status { public IntPtr Code, Information; }
  [DllImport("ntdll.dll")] static extern int NtCreateFile(out SafeFileHandle h, uint access, ref Attributes attrs, out Status status, IntPtr allocation, uint fileAttrs, uint share, uint disposition, uint options, IntPtr ea, uint length);
  [DllImport("ntdll.dll")] static extern int NtSetInformationFile(SafeFileHandle h, out Status status, IntPtr buffer, uint length, int kind);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFileW(string name,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle h,StringBuilder text,uint length,uint flags);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h, out Info info);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationFile(SafeFileHandle h,out Status io,IntPtr buffer,uint length,int kind);
  [DllImport("ntdll.dll")] static extern int NtQueryDirectoryFile(SafeFileHandle h,IntPtr ev,IntPtr apc,IntPtr context,out Status io,IntPtr buffer,uint length,int kind,[MarshalAs(UnmanagedType.U1)]bool single,ref Unicode name,[MarshalAs(UnmanagedType.U1)]bool restart);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFileTime(SafeFileHandle h,ref System.Runtime.InteropServices.ComTypes.FILETIME creation,IntPtr access,IntPtr write);
  public bool StrictScratchMetadata {get;set;}
  // The scratch adapter supports basic NTFS files only, not ReplaceFileW's
  // streams/object IDs/short names/compression/resource-attribute merge.
  static void ValidateScratchMetadata(SafeFileHandle file,SafeFileHandle parent,string leaf) {
    Info info;if(!GetFileInformationByHandle(file,out info))throw new IOException("metadata unavailable");
    if((info.Attributes & ~0xA0u)!=0)throw new IOException("FS_UNSUPPORTED_METADATA: attributes");
    IntPtr b=Marshal.AllocHGlobal(65536);
    try {
      Status io;int code=NtQueryInformationFile(file,out io,b,65536,22);
      if(code<0)throw new IOException("FS_UNSUPPORTED_METADATA: stream query "+code.ToString("X8"));
      if(Marshal.ReadInt32(b)!=0 || Marshal.ReadInt32(b,4)!=14 || Marshal.PtrToStringUni(IntPtr.Add(b,24),7)!="::$DATA")throw new IOException("FS_UNSUPPORTED_METADATA: named streams");
      code=NtQueryInformationFile(file,out io,b,4,7);
      if(code<0||Marshal.ReadInt32(b)!=0)throw new IOException("FS_UNSUPPORTED_METADATA: extended attributes");
      IntPtr pattern=Marshal.StringToHGlobalUni(leaf);
      try{var name=new Unicode{Length=checked((ushort)(leaf.Length*2)),MaximumLength=checked((ushort)(leaf.Length*2+2)),Buffer=pattern};
        code=NtQueryDirectoryFile(parent,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,out io,b,65536,37,true,ref name,true);
        if(code<0||Marshal.ReadByte(b,68)!=0)throw new IOException("FS_UNSUPPORTED_METADATA: short name query "+code.ToString("X8"));
      }finally{Marshal.FreeHGlobal(pattern);}
      int returned;
      if(DeviceIoControl(file,0x9009C,null,0,b,65536,out returned,IntPtr.Zero))throw new IOException("FS_UNSUPPORTED_METADATA: object ID");
      int error=Marshal.GetLastWin32Error();if(error!=2)throw new IOException("FS_UNSUPPORTED_METADATA: object ID query "+error);
      IntPtr owner,group,dacl,sacl,descriptor;
      uint security=GetSecurityInfo(file,1,0x1F0,out owner,out group,out dacl,out sacl,out descriptor);
      try {if(security!=0||sacl!=IntPtr.Zero)throw new IOException("FS_UNSUPPORTED_METADATA: label/resource/scope/trust/access-filter "+security);}
      finally{if(descriptor!=IntPtr.Zero)LocalFree(descriptor);}
    }finally{Marshal.FreeHGlobal(b);}
  }
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DeviceIoControl(SafeFileHandle h,uint code,byte[] input,int size,IntPtr output,int outputSize,out int returned,IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr process,SafeFileHandle source,IntPtr target,out SafeFileHandle copy,uint access,bool inherit,uint options);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool GetVolumeInformationByHandleW(SafeFileHandle h,StringBuilder label,uint labelSize,out uint serial,out uint maxComponent,out uint flags,StringBuilder fs,uint fsSize);
  [DllImport("advapi32.dll")] static extern uint GetSecurityInfo(SafeFileHandle h,int kind,uint flags,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
  [DllImport("advapi32.dll")] static extern uint SetSecurityInfo(SafeFileHandle h,int kind,uint flags,IntPtr owner,IntPtr group,IntPtr dacl,IntPtr sacl);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetSecurityDescriptorControl(IntPtr descriptor,out ushort control,out uint revision);
  [DllImport("advapi32.dll")] static extern bool EqualSid(IntPtr first,IntPtr second);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSidToSidW(string text,out IntPtr sid);
  public static void SetFixtureGroup(string file,string groupSid) {
    CheckProcess();IntPtr sid;
    if(!ConvertStringSidToSidW(groupSid,out sid))throw new IOException("fixture SID invalid");
    try{using(var h=CreateFileW(file,0x80080,3,IntPtr.Zero,3,0x00200000,IntPtr.Zero)){
      if(h.IsInvalid)throw new IOException("fixture group open failed");Check(h,false);
      uint code=SetSecurityInfo(h,1,2,IntPtr.Zero,sid,IntPtr.Zero,IntPtr.Zero);if(code!=0)throw new IOException("fixture group status "+code);
    }}finally{LocalFree(sid);}
  }
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  public string FileSystemName {get;private set;}
  static void CheckProcess() {if(Environment.OSVersion.Platform!=PlatformID.Win32NT||IntPtr.Size!=8||RuntimeInformation.ProcessArchitecture!=Architecture.X64)throw new NotSupportedException("Windows x64 only");}
  public static void ValidatePlatform(string platform,int bits,string fs,uint flags,string architecture) {
    if(platform!="Win32NT"||bits!=64||architecture!="X64"||!String.Equals(fs,"NTFS",StringComparison.OrdinalIgnoreCase)||(flags&0x88)!=0x88)throw new NotSupportedException("Windows x64 NTFS with persistent ACL/reparse support required");
  }
  void ValidateRoot() {
    Check(root,true);uint serial,max,flags;var fs=new StringBuilder(64);var label=new StringBuilder(256);
    if(!GetVolumeInformationByHandleW(root,label,256,out serial,out max,out flags,fs,64))throw new IOException("root filesystem query failed");
    ValidatePlatform(Environment.OSVersion.Platform.ToString(),IntPtr.Size*8,fs.ToString(),flags,RuntimeInformation.ProcessArchitecture.ToString());FileSystemName=fs.ToString();
  }
  sealed class NativeIoException : IOException {public uint Status;public NativeIoException(int status):base("NtCreateFile status "+status.ToString("X8")){Status=unchecked((uint)status);}}
  sealed class AclSnapshot : IDisposable {
    IntPtr descriptor,dacl,owner,group;bool protect;
    public AclSnapshot(SafeFileHandle file) {
      IntPtr sacl;uint code=GetSecurityInfo(file,1,7,out owner,out group,out dacl,out sacl,out descriptor);
      if(code!=0){Dispose();throw new IOException("GetSecurityInfo status "+code);}
      if(owner==IntPtr.Zero||group==IntPtr.Zero){Dispose();throw new IOException("security identity unavailable");}
      ushort control;uint revision;
      if(!GetSecurityDescriptorControl(descriptor,out control,out revision)){Dispose();throw new IOException("DACL control unavailable");}
      protect=(control&0x1000)!=0;
    }
    public void Apply(SafeFileHandle file) {
      uint code=SetSecurityInfo(file,1,7u|(protect?0x80000000u:0x20000000u),owner,group,dacl,IntPtr.Zero);
      if(code!=0)throw new IOException("SetSecurityInfo status "+code);
      using(var actual=new AclSnapshot(file))if(!EqualSid(owner,actual.owner)||!EqualSid(group,actual.group)||protect!=actual.protect)throw new IOException("security identity/control mismatch");
    }
    public void Dispose(){if(descriptor!=IntPtr.Zero){LocalFree(descriptor);descriptor=IntPtr.Zero;}}
  }
  public ScratchCapability(SafeFileHandle authorizedRoot) {
    CheckProcess();
    SafeFileHandle copy;
    if(!DuplicateHandle(new IntPtr(-1),authorizedRoot,new IntPtr(-1),out copy,0,false,2))throw new IOException("root capability duplication failed");
    root=copy;try{ValidateRoot();}catch{root.Dispose();throw;}
  }
  public sealed class RootLease : IDisposable {
    readonly List<SafeFileHandle> handles=new List<SafeFileHandle>();
    readonly object lifetime=new object();
    bool disposed;
    internal string Workspace,WorkspaceId,SessionId,RootId;
    public SafeFileHandle Root {get {return handles[handles.Count-1];}}
    internal void Add(SafeFileHandle handle){handles.Add(handle);}
    public RootLease Guard(){lock(lifetime){if(disposed)throw new ObjectDisposedException("RootLease");var lease=CaptureChain(Workspace,WorkspaceId,SessionId,false,1);if(FileId(lease.Root)!=RootId){lease.Dispose();throw new IOException("SESSION_ROOT_FILE_ID_MISMATCH");}return lease;}}
    public void Dispose(){lock(lifetime){if(disposed)return;disposed=true;for(int n=handles.Count-1;n>=0;n--)handles[n].Dispose();handles.Clear();}}
  }
  static string FileId(SafeFileHandle handle){Info info;if(!GetFileInformationByHandle(handle,out info))throw new IOException("file identity unavailable");return (((ulong)info.IndexHigh<<32)|info.IndexLow).ToString();}
  static SafeFileHandle PinnedDirectory(SafeFileHandle parent,string name,uint disposition,uint share) {
    if(String.IsNullOrEmpty(name)||name=="."||name==".."||name.EndsWith(".")||name.EndsWith(" ")||name.IndexOfAny(new[]{'\\','/',':','\0'})>=0)throw new IOException("invalid bootstrap component");
    IntPtr text=Marshal.StringToHGlobalUni(name),unicode=IntPtr.Zero;
    try {
      var u=new Unicode{Length=checked((ushort)(name.Length*2)),MaximumLength=checked((ushort)(name.Length*2+2)),Buffer=text};
      unicode=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Unicode)));Marshal.StructureToPtr(u,unicode,false);
      var attrs=new Attributes{Length=Marshal.SizeOf(typeof(Attributes)),Root=parent.DangerousGetHandle(),Name=unicode,Flags=0x1040};
      SafeFileHandle handle;Status io;
      // FILE_SHARE_READ pins both the object name and its reparse metadata. A preexisting
      // writer/delete handle makes this fail; later writer/delete opens are refused.
      int code=NtCreateFile(out handle,0x100081,ref attrs,out io,IntPtr.Zero,0,share,disposition,0x200021,IntPtr.Zero,0);
      if(code<0){if(handle!=null)handle.Dispose();throw new NativeIoException(code);}
      try{Check(handle,true);return handle;}catch{handle.Dispose();throw;}
    }finally{if(unicode!=IntPtr.Zero)Marshal.FreeHGlobal(unicode);Marshal.FreeHGlobal(text);}
  }
  public static RootLease Bootstrap(string workspace,string expectedWorkspaceFileId,string sessionId,string expectedRootFileId=null,Action authorize=null) {
    using(var initial=CaptureChain(workspace,expectedWorkspaceFileId,sessionId,true,1,authorize)) {
      if(!String.IsNullOrEmpty(expectedRootFileId)&&FileId(initial.Root)!=expectedRootFileId)throw new IOException("SESSION_ROOT_FILE_ID_MISMATCH");
      var persistent=CaptureChain(workspace,expectedWorkspaceFileId,sessionId,false,3);
      if(FileId(initial.Root)!=FileId(persistent.Root)){persistent.Dispose();throw new IOException("SESSION_ROOT_FILE_ID_MISMATCH");}
      persistent.RootId=FileId(initial.Root);return persistent;
    }
  }
  static RootLease CaptureChain(string workspace,string expectedWorkspaceFileId,string sessionId,bool create,uint share,Action authorize=null) {
    CheckProcess();var lease=new RootLease();
    lease.Workspace=workspace;lease.WorkspaceId=expectedWorkspaceFileId;lease.SessionId=sessionId;
    try {
      string full=Path.GetFullPath(workspace),volume=Path.GetPathRoot(full);
      if(volume.Length!=3||volume[1]!=':'||!String.Equals(full.TrimEnd('\\'),workspace.TrimEnd('\\'),StringComparison.OrdinalIgnoreCase))throw new IOException("canonical local workspace required");
      var drive=CreateFileW(volume,0x100081,share,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
      if(drive.IsInvalid){drive.Dispose();throw new IOException("workspace volume capture failed");}
      lease.Add(drive);Check(drive,true);
      foreach(string component in full.Substring(volume.Length).TrimEnd('\\').Split(new[]{'\\'},StringSplitOptions.RemoveEmptyEntries))lease.Add(PinnedDirectory(lease.Root,component,1,share));
      Info info;if(!GetFileInformationByHandle(lease.Root,out info)||String.IsNullOrEmpty(expectedWorkspaceFileId)||(((ulong)info.IndexHigh<<32)|info.IndexLow).ToString()!=expectedWorkspaceFileId)throw new IOException("WORKSPACE_FILE_ID_MISMATCH");
      using(var validation=new ScratchCapability(lease.Root)){}
      // Validate the session component before the first filesystem mutation.
      if(String.IsNullOrEmpty(sessionId)||sessionId=="."||sessionId==".."||sessionId.EndsWith(".")||sessionId.EndsWith(" ")||sessionId.IndexOfAny(new[]{'\\','/',':','\0'})>=0)throw new IOException("invalid native session component");
      if(authorize!=null)authorize();
      lease.Add(PinnedDirectory(lease.Root,".dsh-verifier-scratch",create?3u:1u,share));
      lease.Add(PinnedDirectory(lease.Root,sessionId,create?3u:1u,share));
      return lease;
    }catch{lease.Dispose();throw;}
  }
  public static SafeFileHandle CaptureFixtureRoot(string physicalRoot) {
    CheckProcess();
    var h=CreateFileW(Path.GetFullPath(physicalRoot),0x100081,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
    if(h.IsInvalid){h.Dispose();throw new IOException("fixture root capture failed");}
    try{Check(h,true);return h;}catch{h.Dispose();throw;}
  }
  public static void SetFixtureJunction(string directory,string target) {
    using(var h=CreateFileW(directory,0x40000100,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero)) {
      if(h.IsInvalid)throw new IOException("fixture reparse open failed "+Marshal.GetLastWin32Error());
      byte[] sub=Encoding.Unicode.GetBytes("\\??\\"+Path.GetFullPath(target)),print=Encoding.Unicode.GetBytes(Path.GetFullPath(target));
      byte[] b=new byte[16+sub.Length+2+print.Length+2];
      Array.Copy(BitConverter.GetBytes(0xA0000003u),0,b,0,4);Array.Copy(BitConverter.GetBytes((ushort)(b.Length-8)),0,b,4,2);
      Array.Copy(BitConverter.GetBytes((ushort)sub.Length),0,b,10,2);Array.Copy(BitConverter.GetBytes((ushort)(sub.Length+2)),0,b,12,2);Array.Copy(BitConverter.GetBytes((ushort)print.Length),0,b,14,2);
      Array.Copy(sub,0,b,16,sub.Length);Array.Copy(print,0,b,18+sub.Length,print.Length);
      int returned;if(!DeviceIoControl(h,0x900A4,b,b.Length,IntPtr.Zero,0,out returned,IntPtr.Zero))throw new IOException("fixture reparse set failed "+Marshal.GetLastWin32Error());
    }
  }
  [StructLayout(LayoutKind.Sequential)] struct Info { public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write; public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow; }
  readonly SafeFileHandle root;
  readonly object gate=new object();
  bool writing,disposed;
  public Action BeforePublishForFixture;
  public Action BeforeCreatedCheckForFixture;
  public Action BeforeReadChunkForFixture;
  public Action BeforeAclApplyForFixture;
  public ScratchCapability(string existingRoot) {
    CheckProcess();
    // The controller supplies an already-authorized physical root; validate the
    // opened object, not just a string before opening it. No directory creation.
    root=CreateFileW(Path.GetFullPath(existingRoot),0x100080,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
    if(root.IsInvalid)throw new IOException("root open failed: "+Marshal.GetLastWin32Error());
    try {
      ValidateRoot();
      var actual=new StringBuilder(32768);uint length=GetFinalPathNameByHandleW(root,actual,32768,0);
      if(length==0||length>=32768)throw new IOException("root identity unavailable");
      string final=actual.ToString();if(final.StartsWith("\\\\?\\"))final=final.Substring(4);
      if(!String.Equals(final.TrimEnd('\\'),Path.GetFullPath(existingRoot).TrimEnd('\\'),StringComparison.OrdinalIgnoreCase))throw new IOException("root identity mismatch");
    } catch { root.Dispose(); throw; }
  }
  static void Check(SafeFileHandle h,bool directory,bool pendingTemp=false) {
    Info i;if(!GetFileInformationByHandle(h,out i))throw new IOException("handle query failed");
    if((i.Attributes&0x400)!=0 || ((i.Attributes&16)!=0)!=directory || (!directory&&i.Links!=(pendingTemp?0:1)))throw new IOException("reparse/type/hardlink refused; links="+i.Links);
  }
  static void DeletePending(SafeFileHandle h,bool value) {
    IntPtr b=Marshal.AllocHGlobal(1);
    try {Marshal.WriteByte(b,value?(byte)1:(byte)0);Status io;int status=NtSetInformationFile(h,out io,b,1,13);if(status<0)throw new IOException("disposition status "+status.ToString("X8"));}
    finally {Marshal.FreeHGlobal(b);}
  }
  SafeFileHandle Open(SafeFileHandle parent,string name,bool directory,uint disposition,uint access) {
    if(String.IsNullOrEmpty(name)||name=="."||name==".."||name.IndexOfAny(new[]{'\\','/',':','\0'})>=0)throw new IOException("invalid component");
    IntPtr text=Marshal.StringToHGlobalUni(name),unicode=IntPtr.Zero;
    try {
      var u=new Unicode{Length=checked((ushort)(name.Length*2)),MaximumLength=checked((ushort)(name.Length*2+2)),Buffer=text};
      unicode=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Unicode)));Marshal.StructureToPtr(u,unicode,false);
      var a=new Attributes{Length=Marshal.SizeOf(typeof(Attributes)),Root=parent.DangerousGetHandle(),Name=unicode,Flags=0x1040};
      SafeFileHandle h;Status io;
      int result=NtCreateFile(out h,access,ref a,out io,IntPtr.Zero,0,directory?3u:0u,disposition,0x200020u|(directory?1u:0x40u),IntPtr.Zero,0);
      if(result<0){if(h!=null)h.Dispose();throw new NativeIoException(result);}
      try{
        if(!directory&&disposition==2){DeletePending(h,true);if(BeforeCreatedCheckForFixture!=null)BeforeCreatedCheckForFixture();}
        Check(h,directory,!directory&&disposition==2);return h;
      }catch(Exception primary){if(!directory&&disposition==2){try{DeletePending(h,true);}catch(Exception cleanup){primary.Data["cleanupError"]=cleanup.Message;}}h.Dispose();throw;}
    } finally {if(unicode!=IntPtr.Zero)Marshal.FreeHGlobal(unicode);Marshal.FreeHGlobal(text);}
  }
  public void Write(string relative,string content,bool replace,Action afterDirectoryOpen) {
    WriteCancelable(relative,content,replace,afterDirectoryOpen,CancellationToken.None);
  }
  public void WriteCancelable(string relative,string content,bool replace,Action afterDirectoryOpen,CancellationToken cancellation) {
    cancellation.ThrowIfCancellationRequested();
    lock(gate){
      if(disposed)throw new ObjectDisposedException("ScratchCapability");
      if(writing)throw new InvalidOperationException("recursive Write refused");
      writing=true;try{WriteCore(relative,content,replace,afterDirectoryOpen,cancellation);}finally{writing=false;}
    }
  }
  static string[] RelativeNames(string relative) {
    if(String.IsNullOrWhiteSpace(relative)||Path.IsPathRooted(relative))throw new IOException("relative path required");
    string[] names=relative.Replace('/','\\').Split('\\');
    foreach(string name in names)if(name.Length==0||name=="."||name==".."||name.IndexOfAny(new[]{':','\0'})>=0)throw new IOException("invalid component");
    return names;
  }
  public void EnsureDirectory(string relative,CancellationToken cancellation) {
    string[] names=RelativeNames(relative);cancellation.ThrowIfCancellationRequested();
    lock(gate){
      if(disposed)throw new ObjectDisposedException("ScratchCapability");if(writing)throw new InvalidOperationException("recursive operation refused");
      writing=true;var handles=new List<SafeFileHandle>();SafeFileHandle parent=root;
      try{foreach(string name in names){cancellation.ThrowIfCancellationRequested();parent=Open(parent,name,true,3,0x100080);handles.Add(parent);}}
      finally{for(int n=handles.Count-1;n>=0;n--)handles[n].Dispose();writing=false;}
    }
  }
  void WriteCore(string relative,string content,bool replace,Action afterDirectoryOpen,CancellationToken cancellation=default(CancellationToken)) {
    if(content==null||content.IndexOf('\0')>=0)throw new IOException("binary text refused before publication");
    if(new UTF8Encoding(false,true).GetByteCount(content)>4194304)throw new IOException("bounded text write exceeded");
    string[] names=RelativeNames(relative);cancellation.ThrowIfCancellationRequested();
    var handles=new List<SafeFileHandle>();SafeFileHandle parent=root;AclSnapshot acl=null;Info original=default(Info);bool hasOriginal=false;
    try {
      for(int n=0;n<names.Length-1;n++){cancellation.ThrowIfCancellationRequested();parent=Open(parent,names[n],true,1,0x100081);handles.Add(parent);}
      // Reparse checks are defense in depth; the write and publication below
      // remain handle-relative even after this check. No absolute-path fallback.
      Check(parent,true);
      if(afterDirectoryOpen!=null)afterDirectoryOpen();
      cancellation.ThrowIfCancellationRequested();
      if(replace){try{using(var source=Open(parent,names[names.Length-1],false,1,0x120089)){if(StrictScratchMetadata)ValidateScratchMetadata(source,parent,names[names.Length-1]);if(!GetFileInformationByHandle(source,out original))throw new IOException("creation time unavailable");hasOriginal=true;acl=new AclSnapshot(source);}}catch(NativeIoException error){if(error.Status!=0xC0000034u)throw;}}
      string temp=StrictScratchMetadata?Guid.NewGuid().ToString("N").Substring(0,8)+".tmp":".cap-"+Guid.NewGuid().ToString("N");
      using(var file=Open(parent,temp,false,2,0x1F0183)) {
        bool published=false;
        Exception primary=null;
        try {
          if(acl!=null){if(BeforeAclApplyForFixture!=null)BeforeAclApplyForFixture();acl.Apply(file);}
          if(hasOriginal && !SetFileTime(file,ref original.Creation,IntPtr.Zero,IntPtr.Zero))throw new IOException("creation time restore failed");
          using(var borrowed=new SafeFileHandle(file.DangerousGetHandle(),false))
          using(var stream=new FileStream(borrowed,FileAccess.Write)) {byte[] bytes=Encoding.UTF8.GetBytes(content);for(int offset=0;offset<bytes.Length;offset+=8192){cancellation.ThrowIfCancellationRequested();stream.Write(bytes,offset,Math.Min(8192,bytes.Length-offset));}stream.Flush(true);}
          // FILE_RENAME_INFORMATION: BOOLEAN, aligned HANDLE, ULONG, WCHAR[].
          byte[] name=Encoding.Unicode.GetBytes(names[names.Length-1]);
          if(names[names.Length-1].IndexOfAny(new[]{'\\','/',':','\0'})>=0 || names[names.Length-1]==".." || name.Length==0)throw new IOException("invalid leaf");
          if(BeforePublishForFixture!=null)BeforePublishForFixture();
          cancellation.ThrowIfCancellationRequested();
          DeletePending(file,false);
          int size=Math.Max(24,20+name.Length);
          IntPtr b=Marshal.AllocHGlobal(size);
          try {
            Marshal.Copy(new byte[size],0,b,size);Marshal.WriteByte(b,replace?(byte)1:(byte)0);
            Marshal.WriteIntPtr(b,8,IntPtr.Zero);Marshal.WriteInt32(b,16,name.Length);Marshal.Copy(name,0,IntPtr.Add(b,20),name.Length);
            Status io;int status=NtSetInformationFile(file,out io,b,(uint)size,10);
            if(status<0)throw new IOException("rename status "+status.ToString("X8"));published=true;
          } finally {Marshal.FreeHGlobal(b);}
        } catch(Exception error){primary=error;throw;} finally {
          // Failed unpublished files close while delete-pending. Preserve the
          // primary exception if a secondary deletion request also fails.
          if(!published) {try{DeletePending(file,true);}catch(Exception cleanup){if(primary==null)throw;primary.Data["cleanupError"]=cleanup.Message;}}
        }
      }
    } finally {if(acl!=null)acl.Dispose();for(int n=handles.Count-1;n>=0;n--)handles[n].Dispose();}
  }
  public sealed class Observation { public string Content; public string Version; }
  public sealed class PathObservation {public string Type;public long Size;public string Version;}
  public PathObservation Probe(string relative) {
    lock(gate){if(disposed)throw new ObjectDisposedException("ScratchCapability");
      if(relative=="")return new PathObservation{Type="directory",Version="root"};
      var names=RelativeNames(relative);var handles=new List<SafeFileHandle>();SafeFileHandle parent=root;
      try{
        for(int n=0;n<names.Length-1;n++){parent=Open(parent,names[n],true,1,0x100080);handles.Add(parent);}
        try{Info i;using(var file=Open(parent,names[names.Length-1],false,1,0x100081)){if(!GetFileInformationByHandle(file,out i))throw new IOException("stat failed");}return new PathObservation{Type="file",Size=((long)i.SizeHigh<<32)|i.SizeLow,Version=ReadCore(relative).Version};}
        catch(NativeIoException e){if(e.Status==0xC00000BAu){using(var dir=Open(parent,names[names.Length-1],true,1,0x100080))return new PathObservation{Type="directory",Version="directory"};}throw;}
      }catch(NativeIoException e){if(e.Status==0xC0000034u||e.Status==0xC000003Au)return null;throw;}
      finally{for(int n=handles.Count-1;n>=0;n--)handles[n].Dispose();}
    }
  }
  Observation ReadCore(string relative,CancellationToken cancellation=default(CancellationToken)) {
    string[] names=RelativeNames(relative);cancellation.ThrowIfCancellationRequested();
    var handles=new List<SafeFileHandle>();SafeFileHandle parent=root;
    try {
      for(int n=0;n<names.Length-1;n++){cancellation.ThrowIfCancellationRequested();parent=Open(parent,names[n],true,1,0x100080);handles.Add(parent);}
      using(var file=Open(parent,names[names.Length-1],false,1,0x100081))
      using(var borrowed=new SafeFileHandle(file.DangerousGetHandle(),false))
      using(var stream=new FileStream(borrowed,FileAccess.Read))
      using(var bytes=new MemoryStream()) {
        var buffer=new byte[8192];int count;
        for(;;){if(BeforeReadChunkForFixture!=null)BeforeReadChunkForFixture();cancellation.ThrowIfCancellationRequested();count=stream.Read(buffer,0,buffer.Length);if(count==0)break;if(bytes.Length+count>4194304)throw new IOException("bounded text read exceeded");bytes.Write(buffer,0,count);}
        byte[] value=bytes.ToArray();string text=new UTF8Encoding(false,true).GetString(value);
        if(text.IndexOf('\0')>=0)throw new IOException("binary text refused");
        Info identity;if(!GetFileInformationByHandle(file,out identity))throw new IOException("version identity unavailable");
        using(var sha=SHA256.Create())return new Observation{Content=text,Version="cap-sha256:"+BitConverter.ToString(sha.ComputeHash(value)).Replace("-","")+":"+identity.Volume+":"+identity.IndexHigh+":"+identity.IndexLow+":"+identity.Write.dwHighDateTime+":"+identity.Write.dwLowDateTime};
      }
    } finally {for(int n=handles.Count-1;n>=0;n--)handles[n].Dispose();}
  }
  public Observation ReadVersioned(string relative) {
    return ReadCancelable(relative,CancellationToken.None);
  }
  public Observation ReadCancelable(string relative,CancellationToken cancellation) {
    cancellation.ThrowIfCancellationRequested();
    lock(gate){if(disposed)throw new ObjectDisposedException("ScratchCapability");if(writing)throw new InvalidOperationException("recursive operation refused");writing=true;try{return ReadCore(relative,cancellation);}finally{writing=false;}}
  }
  public Observation EditObserved(string relative,string expectedVersion,string oldText,string newText) {
    return EditCancelable(relative,expectedVersion,oldText,newText,CancellationToken.None);
  }
  public Observation EditCancelable(string relative,string expectedVersion,string oldText,string newText,CancellationToken cancellation) {
    cancellation.ThrowIfCancellationRequested();
    lock(gate){
      if(disposed)throw new ObjectDisposedException("ScratchCapability");if(writing)throw new InvalidOperationException("recursive operation refused");
      writing=true;
      try {
        if(String.IsNullOrEmpty(expectedVersion))throw new IOException("FS_NOT_OBSERVED");
        var before=ReadCore(relative,cancellation);
        if(!String.Equals(before.Version,expectedVersion,StringComparison.Ordinal))throw new IOException("FS_STALE_VERSION");
        if(String.IsNullOrEmpty(oldText))throw new IOException("empty edit refused");
        int at=before.Content.IndexOf(oldText,StringComparison.Ordinal);
        if(at<0)throw new IOException("edit text not found");
        if(before.Content.IndexOf(oldText,at+oldText.Length,StringComparison.Ordinal)>=0)throw new IOException("ambiguous edit refused");
        string after=before.Content.Substring(0,at)+newText+before.Content.Substring(at+oldText.Length);
        WriteCore(relative,after,true,null,cancellation);
        // Publication has committed. Do not report cancellation after commit.
        return ReadCore(relative);
      } finally {writing=false;}
    }
  }
  public void Dispose(){lock(gate){if(writing)throw new InvalidOperationException("Dispose during Write refused");if(!disposed){disposed=true;root.Dispose();}}}
}
