import type { ComponentProps } from "react";

type AuthInputProps = ComponentProps<"input">;

function AuthInput({ className, ...props }: AuthInputProps) {
  return (
    <input
      {...props}
      className={`w-full p-3 rounded bg-zinc-800 text-white ${className ?? ""}`}
    />
  );
}

export default AuthInput;
