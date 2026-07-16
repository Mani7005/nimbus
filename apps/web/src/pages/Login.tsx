import { useState } from "react";

interface LoginProps {
  onLogin: (email: string, password: string) => void;
}

function Login({ onLogin }: LoginProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  return (
    <div className="min-h-screen flex justify-center items-center bg-zinc-950">
      <div className="bg-zinc-900 p-8 rounded-xl w-96">

        <h1 className="text-3xl text-white font-bold mb-6">
          Nimbus Login
        </h1>

        <input
          className="w-full mb-4 p-3 rounded bg-zinc-800 text-white"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />

        <input
          type="password"
          className="w-full mb-6 p-3 rounded bg-zinc-800 text-white"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        <button
          onClick={() => onLogin(email, password)}
          className="w-full bg-blue-600 hover:bg-blue-700 p-3 rounded text-white"
        >
          Login
        </button>

      </div>
    </div>
  );
}

export default Login;