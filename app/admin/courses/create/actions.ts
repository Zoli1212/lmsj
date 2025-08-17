"use server";

import { requireAdmin } from "@/data/admin/require-admin";
import arcjet, { fixedWindow } from "@/lib/arcjet";
import { prisma } from "@/lib/db";
import { ApiResponse } from "@/lib/types";
import { courseSchema, CourseSchemaType } from "@/lib/zodSchemas";
import { request } from "@arcjet/next";

// Stripe nincs bekötve, nem importálunk stripe-ot

const aj = arcjet.withRule(
  fixedWindow({
    mode: "LIVE",
    window: "1m",
    max: 5,
  })
);

export async function CreateCourse(values: CourseSchemaType): Promise<ApiResponse> {
  const session = await requireAdmin();

  try {
    const req = await request();
    const decision = await aj.protect(req, { fingerprint: session.user.id });

    if (decision.isDenied()) {
      if (decision.reason.isRateLimit()) {
        return { status: "error", message: "You have been blocked due to rate limiting" };
      } else {
        return { status: "error", message: "You are a bot! if this is a mistake contact our support" };
      }
    }

    const parsed = courseSchema.safeParse(values);
    if (!parsed.success) {
      return { status: "error", message: "Invalid Form Data" };
    }

    // Mivel Stripe nincs, stripePriceId mindig null
    await prisma.course.create({
      data: {
        ...parsed.data,
        userId: session.user.id,
        stripePriceId: null,
      },
    });

    return { status: "success", message: "Course created successfully" };
  } catch (err) {
    console.error("CreateCourse error:", err);
    return { status: "error", message: "Failed to create course" };
  }
}
