import type { PropsWithChildren } from "react";

interface AuthCardProps extends PropsWithChildren {
  subtitle: string;
}

function AuthCard({ children, subtitle }: AuthCardProps) {
  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
      <div className="bg-zinc-900 p-8 rounded-xl w-96">
        <h1 className="text-4xl text-white font-bold mb-2">Nimbus</h1>
        <p className="text-zinc-400 mb-8">{subtitle}</p>
        {children}
      </div>
    </div>
  );
}

export default AuthCard;
