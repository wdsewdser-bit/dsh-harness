using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class ScratchMetadataFixture {
  [StructLayout(LayoutKind.Sequential)] struct Status {public IntPtr Code,Information;}
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFileW(string name,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool DeviceIoControl(SafeFileHandle h,uint code,byte[] input,int size,byte[] output,int outputSize,out int returned,IntPtr overlapped);
  [DllImport("ntdll.dll")] static extern int NtSetEaFile(SafeFileHandle h,out Status status,byte[] buffer,uint length);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string text,uint revision,out IntPtr sd,out uint size);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetSecurityDescriptorSacl(IntPtr sd,out bool present,out IntPtr sacl,out bool defaulted);
  [DllImport("advapi32.dll")] static extern uint SetSecurityInfo(SafeFileHandle h,int kind,uint flags,IntPtr owner,IntPtr group,IntPtr dacl,IntPtr sacl);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  public static void Add(string path,string kind) {
    using(var h=CreateFileW(path,0xC0080110,7,IntPtr.Zero,3,0x00200000,IntPtr.Zero)){
      if(h.IsInvalid)throw new IOException("fixture metadata open "+Marshal.GetLastWin32Error());
      int returned;
      if(kind=="objectid"){if(!DeviceIoControl(h,0x900C0,null,0,new byte[64],64,out returned,IntPtr.Zero))throw new IOException("object ID fixture "+Marshal.GetLastWin32Error());}
      else if(kind=="ea") {byte[] value=new byte[]{0,0,0,0,0,3,2,0,67,65,80,0,79,75};Status io;int status=NtSetEaFile(h,out io,value,(uint)value.Length);if(status<0)throw new IOException("EA fixture "+status.ToString("X8"));}
      else if(kind=="compression"){if(!DeviceIoControl(h,0x9C040,new byte[]{1,0},2,null,0,out returned,IntPtr.Zero))throw new IOException("compression fixture "+Marshal.GetLastWin32Error());}
      else if(kind=="label"){
        IntPtr sd;uint length;if(!ConvertStringSecurityDescriptorToSecurityDescriptorW("S:(ML;;NW;;;LW)",1,out sd,out length))throw new IOException("label fixture descriptor");
        try{bool present,def;IntPtr sacl;if(!GetSecurityDescriptorSacl(sd,out present,out sacl,out def)||!present)throw new IOException("label fixture sacl");uint result=SetSecurityInfo(h,1,0x10,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,sacl);if(result!=0)throw new IOException("label fixture status "+result);}finally{LocalFree(sd);}
      }else throw new IOException("unknown fixture metadata");
    }
  }
}
