import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const form = await request.formData();
  const user = String(form.get("user") ?? "");
  if (form.get("password") !== "hunter2") {
    return NextResponse.redirect(new URL("/login?error=1", request.url), 303);
  }
  const response = NextResponse.redirect(new URL("/dashboard", request.url), 303);
  response.cookies.set("session", `user:${user}`, {
    httpOnly: true,
    path: "/",
    maxAge: 3600,
    sameSite: "lax",
  });
  return response;
}
