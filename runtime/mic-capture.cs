using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
public static class SNMicrophone {
  [StructLayout(LayoutKind.Sequential)] struct Format { public ushort tag,channels; public uint rate,bytes; public ushort align,bits,extra; }
  [StructLayout(LayoutKind.Sequential)] struct Header { public IntPtr data; public uint length,recorded; public UIntPtr user; public uint flags,loops; public IntPtr next; public UIntPtr reserved; }
  [DllImport("winmm.dll")] static extern uint waveInGetNumDevs();
  [DllImport("winmm.dll")] static extern uint waveInOpen(out IntPtr h,uint id,ref Format f,IntPtr callback,IntPtr instance,uint flags);
  [DllImport("winmm.dll")] static extern uint waveInPrepareHeader(IntPtr h,IntPtr p,uint size);
  [DllImport("winmm.dll")] static extern uint waveInAddBuffer(IntPtr h,IntPtr p,uint size);
  [DllImport("winmm.dll")] static extern uint waveInUnprepareHeader(IntPtr h,IntPtr p,uint size);
  [DllImport("winmm.dll")] static extern uint waveInStart(IntPtr h);
  [DllImport("winmm.dll")] static extern uint waveInReset(IntPtr h);
  [DllImport("winmm.dll")] static extern uint waveInClose(IntPtr h);
  public static uint DeviceCount(){return waveInGetNumDevs();}
  static void Check(uint code){if(code!=0)throw new IOException("Microphone unavailable (winmm "+code+"). Check Windows microphone permission and default input device.");}
  public static void Run(){
    var f=new Format{tag=1,channels=1,rate=16000,bytes=32000,align=2,bits=16,extra=0};
    IntPtr h=IntPtr.Zero; int size=Marshal.SizeOf(typeof(Header));
    const int bufferBytes = 3200; // 100 ms at 16 kHz mono PCM16
    IntPtr[] headers=new IntPtr[4],buffers=new IntPtr[4];
    using(var ev=new AutoResetEvent(false)){
      Check(waveInOpen(out h,0xffffffff,ref f,ev.SafeWaitHandle.DangerousGetHandle(),IntPtr.Zero,0x50000));
      try{
        for(int i=0;i<4;i++){buffers[i]=Marshal.AllocHGlobal(bufferBytes);headers[i]=Marshal.AllocHGlobal(size);Marshal.StructureToPtr(new Header{data=buffers[i],length=bufferBytes},headers[i],false);Check(waveInPrepareHeader(h,headers[i],(uint)size));Check(waveInAddBuffer(h,headers[i],(uint)size));}
        Check(waveInStart(h)); var output=Console.OpenStandardOutput(); var bytes=new byte[bufferBytes]; int index=0;
        while(true){ev.WaitOne(100);for(int n=0;n<4;n++){var p=headers[index];var v=(Header)Marshal.PtrToStructure(p,typeof(Header));if((v.flags&1)==0)break;if(v.recorded>0){Marshal.Copy(v.data,bytes,0,(int)v.recorded);output.Write(bytes,0,(int)v.recorded);output.Flush();}Check(waveInAddBuffer(h,p,(uint)size));index=(index+1)%4;}}
      }finally{waveInReset(h);for(int i=0;i<4;i++){if(headers[i]!=IntPtr.Zero){waveInUnprepareHeader(h,headers[i],(uint)size);Marshal.FreeHGlobal(headers[i]);}if(buffers[i]!=IntPtr.Zero)Marshal.FreeHGlobal(buffers[i]);}waveInClose(h);}
    }
  }
}
