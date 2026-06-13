"use client"

import { useState, useRef, useEffect, useCallback } from "react"

export function VoiceChat() {
  const [listening, setListening] = useState(false)
  const [transcript, setTranscript] = useState("")
  const [response, setResponse] = useState("")
  const [volume, setVolume] = useState(0)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const recognitionRef = useRef<any>(null)
  const animRef = useRef<number>(0)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const streamRef = useRef<MediaStream | null>(null)

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
      let sum = 0

      for (let i = 0; i < barCount; i++) {
        const value = dataArray[i * step]
        sum += value
        const barHeight = (value / 255) * canvas.height * 0.9
        const barWidth = (canvas.width / barCount) - 4
        const x = i * (canvas.width / barCount) + 2
        const y = canvas.height - barHeight

        const hue = 200 + (value / 255) * 160
        ctx.fillStyle = `hsl(${hue}, 80%, 60%)`
        ctx.fillRect(x, y, barWidth, barHeight)
      }

      setVolume(sum / barCount / 255)
      animRef.current = requestAnimationFrame(draw)
    }

    draw()
  }, [])

  async function startListening() {
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
      setListening(true)

      const SpeechRecognition =
        (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
      if (!SpeechRecognition) {
        setTranscript("Speech recognition not supported in this browser.")
        return
      }

      const recognition = new SpeechRecognition()
      recognition.lang = "en-US"
      recognition.interimResults = true
      recognition.continuous = true

      recognition.onresult = (event: any) => {
        let final = ""
        for (let i = event.resultIndex; i < event.results.length; i++) {
          final += event.results[i][0].transcript
        }
        setTranscript(final)
      }

      recognition.start()
      recognitionRef.current = recognition
    } catch {
      setTranscript("Microphone access denied.")
    }
  }

  function stopListening() {
    recognitionRef.current?.stop()
    recognitionRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    audioCtxRef.current?.close()
    audioCtxRef.current = null
    analyserRef.current = null
    cancelAnimationFrame(animRef.current)
    setListening(false)
    setVolume(0)

    if (canvasRef.current) {
      const ctx = canvasRef.current.getContext("2d")!
      ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height)
    }
  }

  useEffect(() => {
    return () => {
      stopListening()
    }
  }, [])

  async function sendPrompt() {
    if (!transcript.trim()) return
    try {
      const res = await fetch("http://localhost:8080/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: transcript }),
      })
      const data = await res.json()
      setResponse(data.answer)
      const utterance = new SpeechSynthesisUtterance(data.answer)
      utterance.rate = 0.95
      speechSynthesis.speak(utterance)
    } catch {
      setResponse("Could not reach the server.")
    }
  }

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
        {transcript || (listening ? "Listening..." : "Press the mic and speak.")}
      </p>

      {response && (
        <p className="text-sm bg-muted rounded-xl px-4 py-2 max-w-md text-center">
          {response}
        </p>
      )}

      <div className="flex gap-3">
        {!listening ? (
          <button
            onClick={startListening}
            className="size-14 rounded-full bg-primary text-primary-foreground text-2xl flex items-center justify-center hover:opacity-90 transition"
          >
            🎤
          </button>
        ) : (
          <>
            <button
              onClick={sendPrompt}
              className="size-14 rounded-full bg-green-600 text-white text-xl flex items-center justify-center hover:opacity-90 transition"
            >
              ➤
            </button>
            <button
              onClick={stopListening}
              className="size-14 rounded-full bg-destructive text-destructive-foreground text-xl flex items-center justify-center hover:opacity-90 transition"
            >
              ■
            </button>
          </>
        )}
      </div>
    </div>
  )
}
