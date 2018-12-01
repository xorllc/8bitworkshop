"use strict";

import { Platform, BaseMAMEPlatform, BaseZ80Platform, getToolForFilename_z80 } from "../baseplatform";
import { PLATFORMS, RAM, newAddressDecoder, padBytes, noise, setKeyboardFromMap, AnimationTimer, RasterVideo, Keys, makeKeycodeMap } from "../emu";
import { hex, lzgmini, stringToByteArray } from "../util";
import { MasterAudio, SN76489_Audio } from "../audio";
import { TMS9918A, SMSVDP } from "../video/tms9918a";
import { ColecoVision_PRESETS } from "./coleco";

// http://www.smspower.org/Development/Index
// http://www.smspower.org/uploads/Development/sg1000.txt
// http://www.smspower.org/uploads/Development/richard.txt

// TODO: merge w/ coleco
export var SG1000_PRESETS = [
  {id:'text.c', name:'Text Mode'},
  {id:'hello.c', name:'Scrolling Text'},
  {id:'text32.c', name:'32-Column Color Text'},
  {id:'stars.c', name:'Scrolling Starfield'},
  {id:'cursorsmooth.c', name:'Moving Cursor'},
  {id:'simplemusic.c', name:'Simple Music'},
  {id:'musicplayer.c', name:'Multivoice Music'},
  {id:'mode2bitmap.c', name:'Mode 2 Bitmap'},
  {id:'mode2compressed.c', name:'Mode 2 Bitmap (LZG)'},
  {id:'lines.c', name:'Mode 2 Lines'},
  {id:'multicolor.c', name:'Multicolor Mode'},
  {id:'siegegame.c', name:'Siege Game'},
  {id:'shoot.c', name:'Solarian Game'},
  {id:'climber.c', name:'Platform Game'},
];


var SG1000_KEYCODE_MAP = makeKeycodeMap([
  [Keys.VK_UP,    0, 0x1],
  [Keys.VK_DOWN,  0, 0x2],
  [Keys.VK_LEFT,  0, 0x4],
  [Keys.VK_RIGHT, 0, 0x8],
  [Keys.VK_SPACE, 0, 0x10],
  [Keys.VK_CONTROL, 0, 0x20],

  [Keys.VK_R, 0, 0x40],
  [Keys.VK_F, 0, 0x80],
  [Keys.VK_D, 1, 0x1],
  [Keys.VK_G, 1, 0x2],
  [Keys.VK_A, 1, 0x4],
  [Keys.VK_S, 1, 0x8],
  [Keys.VK_1, 1, 0x10],
]);

/// standard emulator

const _SG1000Platform = function(mainElement, isSMS:boolean) {

  const cpuFrequency = 3579545; // MHz
  const canvasWidth = 304;
  const numTotalScanlines = 262;
  const numVisibleScanlines = 240;
  const cpuCyclesPerLine = Math.round(cpuFrequency / 60 / numTotalScanlines);

  var cpu, ram, membus, iobus, rom;
  var video, vdp, timer;
  var audio, psg;
  var inputs = new Uint8Array(4);

  class SG1000Platform extends BaseZ80Platform implements Platform {
  
    currentScanline;

    getPresets() { return SG1000_PRESETS; }

    start() {
       var ramSize = isSMS ? 0x2000 : 0x400;
       ram = new RAM(ramSize);
       membus = {
         read: newAddressDecoder([
           [0xc000, 0xffff, ramSize-1, function(a) { return ram.mem[a]; }],
           [0x0000, 0xbfff, 0xffff,    function(a) { return rom ? rom[a] : 0; }],
	       ]),
         write: newAddressDecoder([
           [0xc000, 0xffff, ramSize-1, function(a,v) { ram.mem[a] = v; }],
         ]),
         isContended: function() { return false; },
      };
      iobus = {
        read: (addr:number) => {
  				addr &= 0xff;
          //console.log('IO read', hex(addr,4));
          switch (addr & 0xc1) {
            case 0x40: return isSMS ? this.currentScanline : 0;
            case 0x80: return vdp.readData();
            case 0x81: return vdp.readStatus();
            case 0xc0: return inputs[0] ^ 0xff;
            case 0xc1: return inputs[1] ^ 0xff;
          }
          return 0;
      	},
      	write: (addr:number, val:number) => {
  				addr &= 0xff;
  				val &= 0xff;
          //console.log('IO write', hex(addr,4), hex(val,2));
          switch (addr & 0xc1) {
            case 0x80: return vdp.writeData(val);
            case 0x81: return vdp.writeAddress(val);
            case 0x40:
            case 0x41: return psg.setData(val);
          }
      	}
      };
      cpu = this.newCPU(membus, iobus);
      video = new RasterVideo(mainElement,canvasWidth,numVisibleScanlines,{overscan:true});
      video.create();
      audio = new MasterAudio();
      psg = new SN76489_Audio(audio);
      var cru = {
        setVDPInterrupt: (b) => {
          if (b) {
            cpu.nonMaskableInterrupt();
          } else {
            // TODO: reset interrupt?
          }
        }
      };
      var vdpclass = isSMS ? SMSVDP : TMS9918A;
      vdp = new vdpclass(video.getFrameData(), cru, true); // true = 4 sprites/line
      setKeyboardFromMap(video, inputs, SG1000_KEYCODE_MAP);
      timer = new AnimationTimer(60, this.nextFrame.bind(this));
    }

    readAddress(addr) {
      return membus.read(addr);
    }

    advance(novideo : boolean) {
      for (var sl=0; sl<numTotalScanlines; sl++) {
        this.currentScanline = sl;
        this.runCPU(cpu, cpuCyclesPerLine);
        vdp.drawScanline(sl);
      }
      video.updateFrame();
    }

    loadROM(title, data) {
      if (data.length < 0xc000) {
        rom = padBytes(data, 0xc000);
      } else {
        switch (data.length) {
          case 0x10000:
          case 0x20000:
          case 0x40000:
            rom = data;
            break;
          default:
            throw "Unknown rom size: $" + hex(data.length);
        }
      }
      this.reset();
    }

    loadState(state) {
      cpu.loadState(state.c);
      ram.mem.set(state.b);
      vdp.restoreState(state.vdp);
      inputs.set(state.in);
    }
    saveState() {
      return {
        c:this.getCPUState(),
        b:ram.mem.slice(0),
        vdp:vdp.getState(),
        in:inputs.slice(0),
      };
    }
    loadControlsState(state) {
      inputs.set(state.in);
    }
    saveControlsState() {
      return {
        in:inputs.slice(0)
      };
    }
    getCPUState() {
      return cpu.saveState();
    }

    isRunning() {
      return timer && timer.isRunning();
    }
    pause() {
      timer.stop();
      audio.stop();
    }
    resume() {
      timer.start();
      audio.start();
    }
    reset() {
      cpu.reset();
      cpu.setTstates(0);
      vdp.reset();
      psg.reset();
    }

    getDebugCategories() {
      return super.getDebugCategories().concat(['VDP']);
    }
    getDebugInfo(category, state) {
      switch (category) {
        case 'VDP': return this.vdpStateToLongString(state.vdp);
        default: return super.getDebugInfo(category, state);
      }
    }
    vdpStateToLongString(ppu) {
      return vdp.getRegsString();
    }
  }
  return new SG1000Platform();
}

///

const _SMSPlatform = function(mainElement) {
  this.__proto__ = new (_SG1000Platform as any)(mainElement, true);
}

///

PLATFORMS['sms-sg1000-libcv'] = _SG1000Platform;
PLATFORMS['sms-sms-libcv'] = _SMSPlatform;
