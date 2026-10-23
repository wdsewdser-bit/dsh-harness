using System;
using System.IO;
using System.Threading;
public static class InputFaultFixture {
  public static void Run(string root,string id,string release) {
    ScratchBridgeRuntime.RunForFixture(root,id,cap=>{
      cap.BeforePublishForFixture=()=>{
        Console.Error.WriteLine("FIXTURE_BEFORE_PUBLICATION");Console.Error.Flush();
        var deadline=DateTime.UtcNow.AddSeconds(15);
        while(!File.Exists(release)){if(DateTime.UtcNow>deadline)throw new IOException("fixture release timed out");Thread.Sleep(10);}
      };
    });
  }
}
