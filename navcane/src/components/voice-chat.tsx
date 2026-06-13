"use client"

import { useState, useRef, useEffect, useCallback } from "react"

export function VoiceChat() {
  const [recording, setRecording] = useState(false)
  const [transcript, setTranscript] = useState("")
  const [loading, setLoading] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const animRef = useRef<number>(0)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])

  const drawVisualizer = useCallback(() => {
    if (!canvasRef.current || !analyserRef.current) return
    const canvas = canvasRef.current
    const ctx = canvas.getContext("2d")!
    const analyser = analyserRef.current
    const bufferLength = analyser.frequencyBinCount
    const dataArray = new Uint8Array(bufferLength)

    function draw() {
      analyser.getByteFrequencyData(dataArray)
      ctx.clearRect(0, 0, canvas.width, canvas.height)

      const barCount = 32
      const step = Math.floor(bufferLength / barCount)

      for (let i = 0; i < barCount; i++) {
        const value = dataArray[i * step]
        const barHeight = (value / 255) * canvas.height * 0.9
        const barWidth = (canvas.width / barCount) - 4
        const x = i * (canvas.width / barCount) + 2
        const y = canvas.height - barHeight

        const hue = 200 + (value / 255) * 160
        ctx.fillStyle = `hsl(${hue}, 80%, 60%)`
        ctx.fillRect(x, y, barWidth, barHeight)
      }

      animRef.current = requestAnimationFrame(draw)
    }

    draw()
  }, [])

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream

      const audioCtx = new AudioContext()
      audioCtxRef.current = audioCtx
      const source = audioCtx.createMediaStreamSource(stream)
      sourceRef.current = source
      const analyser = audioCtx.createAnalyser()
      analyser.fftSize = 256
      source.connect(analyser)
      analyserRef.current = analyser

      drawVisualizer()

      chunksRef.current = []
      const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" })
      recorderRef.current = recorder

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }

      recorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: "audio/webm" })
        await transcribeAudio(blob)
      }

      recorder.start()
      setRecording(true)
      setTranscript("")
    } catch {
      setTranscript("Microphone access denied.")
    }
  }

  async function transcribeAudio(blob: Blob) {
    setLoading(true)
    const formData = new FormData()
    formData.append("audio", blob, "recording.webm")

    try {
      const res = await fetch("http://localhost:8080/transcribe", {
        method: "POST",
        body: formData,
      })
      const data = await res.json()
      setTranscript(data.text || "")
    } catch {
      setTranscript("Transcription failed.")
    } finally {
      setLoading(false)
    }
  }

  function stopRecording() {
    recorderRef.current?.stop()
    recorderRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    audioCtxRef.current?.close()
    audioCtxRef.current = null
    analyserRef.current = null
    cancelAnimationFrame(animRef.current)
    setRecording(false)

    if (canvasRef.current) {
      const ctx = canvasRef.current.getContext("2d")!
      ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height)
    }
  }

  useEffect(() => {
    return () => {
      recorderRef.current?.stop()
      streamRef.current?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  return (
    <div className="flex flex-col items-center justify-center h-screen gap-6 px-4">
      <h1 className="text-lg font-semibold">Voice Chat</h1>

      <canvas
        ref={canvasRef}
        width={300}
        height={120}
        className="rounded-xl border bg-black/5 dark:bg-white/5"
      />

      <p className="text-sm text-muted-foreground min-h-[3rem] text-center max-w-md">
        {loading
          ? "Transcribing..."
          : transcript || (recording ? "Recording... tap stop when done" : "Press the mic and speak.")}
      </p>

      <div className="flex gap-3">
        {!recording ? (
          <button
            onClick={startRecording}
            className="size-14 rounded-full bg-primary text-primary-foreground text-2xl flex items-center justify-center hover:opacity-90 transition"
          >
            🎤
          </button>
        ) : (
          <button
            onClick={stopRecording}
            className="size-14 rounded-full bg-destructive text-destructive-foreground text-xl flex items-center justify-center hover:opacity-90 transition"
          >
            ■
          </button>
        )}
      </div>
    </div>
  )
}
