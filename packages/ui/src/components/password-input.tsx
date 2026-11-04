"use client";

import { Input } from "@hyori-cloud/ui/components/input";
import { cn } from "@hyori-cloud/ui/lib/utils";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import * as React from "react";

function PasswordInput({ className, ...props }: Omit<React.ComponentProps<"input">, "type">) {
  const [visible, setVisible] = React.useState(false);

  return (
    <div className="relative">
      <Input
        type={visible ? "text" : "password"}
        spellCheck={false}
        autoCapitalize="off"
        className={cn("pr-9", className)}
        {...props}
      />
      <button
        type="button"
        aria-label={visible ? "Hide password" : "Show password"}
        aria-pressed={visible}
        onClick={() => setVisible(!visible)}
        className="absolute inset-y-0 right-0 grid w-9 place-items-center rounded-r-md text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 [&_svg]:size-4 [&_svg]:stroke-[1.75]"
      >
        {visible ? <EyeOffIcon aria-hidden /> : <EyeIcon aria-hidden />}
      </button>
    </div>
  );
}

export { PasswordInput };
