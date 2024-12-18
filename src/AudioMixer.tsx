import { useState, useRef } from "react";
import { useDropzone } from "react-dropzone";
import Draggable from 'react-draggable';
import { atom, useAtom, useAtomValue, getDefaultStore } from 'jotai'
import { mixerLength as mixerLengthAtom, mixerTracks as mixerTracksAtom, isPlaying as isPlayingAtom, cursorTime as cursorTimeAtom, selectedClip } from "./store";
import toWav from 'audiobuffer-to-wav'

// 50px/s
let timeResolution = 50;

const store = getDefaultStore();
const AudioContext = (window.AudioContext || window.webkitAudioContext);
let audioContext = new AudioContext();
let playbackStart = 0;
// the atom subscrptions that are alive during the playback is playing
let unsubs = [];

/* -- loading files -- */
const decodeAudioFile = async (files) => {
    const audioFiles = files.map((audioFile) => 
      new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = async () => {
          const audioBuffer = await audioContext.decodeAudioData(reader.result);
          resolve({ file: audioFile, buffer: audioBuffer, duration: audioBuffer.duration, waveformImage: generateWaveformImage(audioBuffer, 100) });
        };
        reader.readAsArrayBuffer(audioFile);
      }));
    return await Promise.all(audioFiles);
};

const generateWaveformImage = (audioBuffer, height = 100) => {
  const channelData = audioBuffer.getChannelData(0); // 左チャンネルのデータのみ取得

  // filtfilt high-pass IIR
  let old = 0;
  const alpha = 0.93;
  const filtered = new Float32Array(audioBuffer.length);
  for (let i = 0; i < audioBuffer.length; i++) {
    old = alpha * old + (1 - alpha) * channelData[i];
    filtered[i] = old;
  }
  old = 0;
  for (let i = audioBuffer.length -1; i >= 0; i--) {
    old = (alpha * old + (1 - alpha) * filtered[i]);
    filtered[i] = channelData[i] - old;
  }

  const step = Math.floor(audioBuffer.sampleRate / timeResolution);
  const width = Math.floor(audioBuffer.length / step);
  // RGBA buffer
  const imageData = new Uint8ClampedArray(width * height * 4);

  // initialize with transparent fill
  for (let i = 0; i < imageData.length; i++) {
    imageData[i] = 0;
  }

  // draw bars
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let i = 0; i < step; i++) {
      const s = channelData[x * step + i];
      sum += s*s;
    }
    // root mean square amplitude
    const avg = Math.sqrt(sum / step);
    const barHeight = 2 * Math.floor(avg * height);
    const centerY = Math.floor(height / 2);

    for (let y = centerY - barHeight / 2; y < centerY + barHeight / 2; y++) {
      const index = (y * width + x) * 4;
      imageData[index] = 100;
      imageData[index + 1] = 100;
      imageData[index + 2] = 180;
      imageData[index + 3] = 255;
    }
  }

  // draw high frequency component
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let i = 0; i < step; i++) {
      const s = filtered[x * step + i];
      sum += s*s;
    }
    const avg = Math.sqrt(sum / step);
    const barHeight = 2 * Math.floor(avg * height);
    const centerY = Math.floor(height / 2);

    for (let y = centerY - barHeight / 2; y < centerY + barHeight / 2; y++) {
      const index = (y * width + x) * 4;
      imageData[index] = 220;
      imageData[index + 1] = 120;
      imageData[index + 2] = 20;
      imageData[index + 3] = 255;
    }
  }
  return createImageFromData(imageData, width, height);
};

// convert BufferArray into data URI using canvas
const createImageFromData = (imageDataArray, width, height) => {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");
  const imageData = new ImageData(imageDataArray, width, height);
  ctx.putImageData(imageData, 0, 0);

  // Base64 Data URI
  return canvas.toDataURL();
};

/* -- audio editing APIs -- */
// split selecte clip at cursor
const splitSelectedClip = () => {
  const clipAtom = store.get(selectedClip);
  if (!clipAtom) return;
  const clip = store.get(clipAtom);
  
  let cursorTime = store.get(cursorTimeAtom);
  const isPlaying = store.get(isPlayingAtom);
  if (isPlaying) {
    cursorTime = playbackStart + audioContext.currentTime;
  }
  if (cursorTime <= clip.startTime) {
    return;
  }
  const newDuration = cursorTime - clip.startTime;
  if (clip.duration <= newDuration) {
    return;
  }
  store.set(clipAtom, {...clip, duration: newDuration });

  const track = store.get(clip.track);
  const newClip = {id: crypto.randomUUID(), duration: clip.duration - newDuration, offsetTime: clip.offsetTime + newDuration, startTime: clip.startTime + newDuration, file: clip.file, track: clip.track};
  store.set(clip.track, {...track, clips: [...track.clips, atom(newClip)]});
}

// load audio file to the specified track
const addClips = (track, files) => {
  const newClips = [];
  let t = 0;
  files.forEach((file) => {
      newClips.push( atom({ id: crypto.randomUUID(), track, duration: file.duration, file, startTime: t, offsetTime: 0 }));
      t += file.duration;
    });
  const prev = store.get(track);
  store.set(track, { ...prev, clips: [ ...prev.clips, ...newClips ]});
  return newClips;
}

// length of the entire mix
const mixDuration = () => {
   const endOfClips = store.get(mixerTracksAtom).map((pair) => {
      const [id, track] = pair;
      const t = store.get(track);
      return t.clips.map((clip) => store.get(clip)).map((clip) => clip.startTime + clip.duration);
   }).flat();
   return Math.max(...endOfClips);
}

// remove clips from the track (and hence the mix)
const removeClip = (clipAtom) => {
  const clip = store.get(clipAtom);
  // stop audio
  store.set(clipAtom, {...clip, duration: 0});
  const track = store.get(clip.track);
  store.set(clip.track, {...track, clips: track.clips.filter((c) => c !== clipAtom)});
};

// move a clip from a track to another track
const moveClip = (clipAtom, newClip, toTrack) => {
  removeClip(clipAtom);
  const newTrack = store.get(toTrack);
  store.set(toTrack, {...newTrack, clips: [...newTrack.clips, atom(newClip)]});
};

// get a cardinal number of the track
const trackNumber = (track) => {
  return store.get(mixerTracksAtom).findIndex((x) => x[1] === track);
};

/* -- audio playing APIs -- */
// todo: promise APIs is not complete (which is to be resolved when the entire mix has been played)
// todo: separate pause APIs from the component
const playMixAudio = () => {
   audioContext = new AudioContext();
   const store = getDefaultStore();
   const cursorTime = store.get(cursorTimeAtom);
   playbackStart = cursorTime;
   const tracks = store.get(mixerTracksAtom).map((pair) => {
      const [id, track] = pair;
      const t = store.get(track);
      return { atom: track, volume: t.volume, clips: t.clips.map((clip) => ({ atom: clip, ...store.get(clip) })) } });

   const playClip = function(track, clip, resolve) {
      const currentTime =  audioContext.currentTime;
      let source = audioContext.createBufferSource();
      source.buffer = clip.file.buffer;
      const now = cursorTime + currentTime;
   
      const gainNode = audioContext.createGain();
      gainNode.gain.value = Math.exp(track.volume);
      let gainUnsub = store.sub(track.atom, () => { console.log("volume changed", clip.id, store.get(track.atom).volume), gainNode.gain.value = Math.exp(store.get(track.atom).volume) });
      unsubs.push(gainUnsub);
      source.connect(gainNode).connect(audioContext.destination);
      const startTime = clip.startTime - now;;
      const offsetTime = clip.offsetTime + ((startTime < 0) ? -startTime : 0);
      const duration = clip.duration + ((startTime < 0) ? startTime : 0);
      if (duration < 0) {
        return resolve();
      }
      source.start((startTime < 0) ? currentTime : currentTime + startTime, offsetTime, duration);
      unsubs.push(store.sub(clip.atom, () => {
            console.log("clip update");
            const newClip = store.get(clip.atom);
            const currentTime =  audioContext.currentTime;
            const now = cursorTime + currentTime;
            try {
                source.stop();
            } catch {
            }
            source.disconnect();
            source = audioContext.createBufferSource();
            source.buffer = newClip.file.buffer;
            gainNode.gain.value = Math.exp(store.get(newClip.track).volume);
            source.connect(gainNode) // .connect(audioContext.destination);
            const startTime = newClip.startTime - now;;
            const offsetTime = newClip.offsetTime + ((startTime < 0) ? -startTime : 0);
            const duration = newClip.duration + ((startTime < 0) ? startTime : 0);
            if (duration < 0) {
              return resolve();
            }
            source.start((startTime < 0) ? currentTime : currentTime + startTime, offsetTime, duration);
      }));
      source.onended = () => { resolve() };
   }

   return Promise.all(tracks.map((track) => {
       let clipIds = track.clips.map((clip) => clip.id);
       unsubs.push(store.sub(track.atom, () => {
          const t = store.get(track.atom);
          t.clips.forEach((clipAtom) => {
              const clip = store.get(clipAtom);
              if (!clipIds.some((id) => id === clip.id)) {
                console.log("new clip", clip.id);
                return new Promise((resolve, reject) => playClip({ atom: track.atom, ...t }, { atom: clipAtom, ...clip }, resolve));
              }
          });
          clipIds = t.clips.map((clipAtom) => store.get(clipAtom).id);
       }));
       return Promise.all(track.clips.map((clip) => (
           new Promise((resolve, reject) => {
               playClip(track, clip, resolve);
           })
       )))
   }));
}

const renderMixAudio = async () => {
   const offlineAudioContext = new OfflineAudioContext(2, 44100 * mixDuration(), 44100);
   const store = getDefaultStore();
   const tracks = store.get(mixerTracksAtom).map((pair) => {
      const [id, track] = pair;
      const t = store.get(track);
      return { atom: track, volume: t.volume, clips: t.clips.map((clip) => ({ atom: clip, ...store.get(clip) })) } });
   tracks.forEach((track) => 
       track.clips.forEach((clip) => {
               const source = offlineAudioContext.createBufferSource();
               source.buffer = clip.file.buffer;
   
               const gainNode = offlineAudioContext.createGain();
               gainNode.gain.value = Math.exp(track.volume);
   
               source.connect(gainNode).connect(offlineAudioContext.destination);
               source.start(clip.startTime, clip.offsetTime, clip.duration);
           })
       );
   const renderedBuffer = await offlineAudioContext.startRendering();
   return new Blob([new DataView(toWav(renderedBuffer))], { type: "audio/wav" });
}


// fire when the clip is dropped
const onDragStop = (clipAtom) => {
  const clip = store.get(clipAtom);
  return (e, position) => {
    const relativeIndex = Math.round(position.y / 120);
    const newStartTime = Math.max(0, position.x / timeResolution);
    if (relativeIndex !== 0) {
       const destination = relativeIndex + trackNumber(clip.track);
       if (destination === -1) {
          removeClip(clipAtom);
       } else if (destination < store.get(mixerTracksAtom).length) {
          const toTrack =  store.get(mixerTracksAtom)[destination][1];
          moveClip(clipAtom, { ...clip, startTime: newStartTime, track: toTrack }, toTrack);
       } else {
          return; // abort
       }
    } else {
      store.set(clipAtom, { ...clip, startTime: newStartTime });
    }
  }
}

/* -- React Components -- */
const AudioClip = (props) => {
   const [clip, setClip] = useAtom(props.clip);
   const [selected, select] = useAtom(selectedClip);
   const isSelected = (selected === props.clip);
   return (
      <Draggable grid={[1, 120]} position={{x: clip.startTime * timeResolution, y: 0}} onStop={onDragStop(props.clip)}>
         <div onClick={() => select(props.clip)} onTouchStart={() => selet(props.clip)}
             key={props.id}
             className={isSelected ? "selected clip" : "clip"}
             style={{
                 width: `${clip.duration * timeResolution}px`, // Example width scaling for duration
             }}
         >
         <img
          src={clip.file.waveformImage}
          draggable="false"
          style={{position: "relative", left: `${-timeResolution * clip.offsetTime}px`}}
          alt="Waveform"/>
         </div>
      </Draggable>
   )};


const AudioTrack = (props) => {
   const [track, setTrack] = useAtom(props.track);
   const [, selectClip] = useAtom(selectedClip);
   const onDrop = async (acceptedFiles) => {
      const newAudioFiles = await decodeAudioFile(acceptedFiles);
      const newClips = addClips(props.track, newAudioFiles)
      selectClip(newClips[0]);
   };

   const { getRootProps, getInputProps } = useDropzone({ onDrop, accept: "audio/*" });
   return (
    <div key={props.id} className="track">
        {/* Volume Control */}
        <div className="stickyTrack">
            <div className="volume">
                <label>音量 </label>
                <input
                    type="range"
                    min="-4"
                    max="1"
                    step="0.01"
                    value={track.volume}
                    onChange={(e) => setTrack((prev) => ({ ...prev, volume: e.target.value }))}
                />
            </div>

            {/* File Upload */}
            { (track.clips.length == 0) ?
              <div {...getRootProps({ className: "dropzone" })}>
                  <input {...getInputProps()} />
                  <p>ここをクリックして音声ファイルを選択 / ここに音声ファイルをドロップ</p>
              </div> : [] }
        </div>
        {/* Clip List */}
        <div className="clipList">
            {track.clips.map((clip) => (<AudioClip clip={clip}/>))}
        </div>
    </div>
  )};


const AudioMixer = () => {
    const [mixerTracks, setMixerTracks] = useAtom(mixerTracksAtom);
    const [isPlaying, setIsPlaying] = useAtom(isPlayingAtom);
    const mixerLength = useAtomValue(mixerLengthAtom);
    const [isCursorUpdated, setIsCursorUpdated] = useState(false); // Playback state
    const [cursorTime, setCursorTime] = useAtom(cursorTimeAtom);
    const mainRef = useRef(null);

    // Add a new track
    const addTrack = () => {
        const track = atom({ id: crypto.randomUUID(), clips: [], volume: 0.0 });
        store.sub(track, () => console.log("track updated", store.get(track)))
        setMixerTracks((prev) => [...prev, [track.id, track]]);
    };

    // Play the entire mix
    const playMix = () => {
        console.log("play");
        if (isPlaying) return;
        setIsPlaying(true);
        const promise = playMixAudio();
        setTimeout(animatePlayback, 10);
    };

    // Pause the playback
    const pauseMix = () => {
        console.log("pause");
        const currentTime = audioContext.currentTime;
        unsubs.forEach((unsub) => unsub());
        unsubs = [];
        audioContext.close();
        setIsPlaying(false);
        setCursorTime(playbackStart + currentTime);
    };

    const resetCursor = () => {
      if (isPlaying) {
        pauseMix();
      }
      setCursorTime(0);
      mainRef.current.scrollTo({ left: 0 });
    }

    // Playback animation
    const animatePlayback = () => {
        console.log("animate", store.get(isPlayingAtom));
        if (store.get(isPlayingAtom)) {
            const cursorTime = (playbackStart + audioContext.currentTime);
            setCursorTime(cursorTime);
            if (mainRef.current.scrollLeft + innerWidth - cursorTime * timeResolution < 100) {
              mainRef.current.scrollTo({ left: cursorTime * timeResolution - 50, behavior: "smooth" });
            }
            // stop animation
            setIsCursorUpdated(true);
            requestAnimationFrame(function(time) {
              requestAnimationFrame(function(time) {
                setCursorTime(playbackStart + audioContext.currentTime);
                // restart animation
                setIsCursorUpdated(false);
              });
            });
            setTimeout(animatePlayback, 1000);
        }
    };

    // Export the mix as a WAV file
    const exportMix = async () => {
        const wavBlob = await renderMixAudio();
        const url = URL.createObjectURL(wavBlob);
        const a = document.createElement("a");
        a.style.display = "none";
        a.href = url;
        a.download = "mix.wav";
        document.body.appendChild(a);
        a.click();
        URL.revokeObjectURL(url);
    };

    return (
        <div>
            <h1>Web音声編集くん</h1>
            <div style={{overflowX: "scroll", width: "100%", position: "relative"}} ref={mainRef} onDoubleClick={(e) => {
                    if (isPlaying) {
                        pauseMix();
                    }
                    setCursorTime((mainRef.current.scrollLeft + e.pageX) / timeResolution);}}>

                {/* Track List */}
                <div className="track-container" style={{width: `${mixerLength * timeResolution}px`}}>
                   <div className="delete-area">
                     <div className="delete-description">
                       ここにドロップしてクリップを削除 
                     </div>
                   </div>
                   {mixerTracks.map((track) => (<AudioTrack key={track[0]} track={track[1]} />))}
                   <div className="add-area">
                     <button onClick={addTrack}> + トラックを追加</button>
                   </div>
                </div>

                {/* Playback Position Indicator */}
                <div style={{
                        position: "absolute",
                        zIndex: 100,
                        top: 0,
                        left: `${(cursorTime * timeResolution) - 1}px`,
                        height: "100%",
                    }}
                    className={isPlaying && !isCursorUpdated ? "cursor active" : "cursor"}
                />

                <div className="placeholder-footer"/>
            </div>

            <div className="controllers">
            {/* Playback and Export Controls */}
            {isPlaying ? (
                <button onClick={pauseMix}>⏸ 停止</button>
            ) : (
                <button onClick={playMix}>▷ 再生</button>
            )}
            <button onClick={resetCursor}> |&lt; 先頭に</button>
            <button onClick={splitSelectedClip}>|| 分割</button>
            <button onClick={exportMix}>保存</button>
            </div>
        </div>
    );
};

export default AudioMixer;
