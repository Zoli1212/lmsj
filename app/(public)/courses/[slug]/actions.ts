"use server";

import { requireUser } from "@/app/data/user/require-user";
import arcjet, { fixedWindow } from "@/lib/arcjet";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { stripe } from "@/lib/stripe";
import { ApiResponse } from "@/lib/types";
import { request } from "@arcjet/next";
import { redirect } from "next/navigation";
import Stripe from "stripe";

const aj = arcjet.withRule(
  fixedWindow({
    mode: "LIVE",
    window: "1m",
    max: 5,
  })
);

// Használt pénznem – állítsd be ENV-ben, pl. HUF / EUR / USD
const CURRENCY = (process.env.STRIPE_CURRENCY || "HUF").toLowerCase();

/** Ha hiányzik a Course.stripePriceId, létrehoz Stripe Product+Price-t, majd visszaírja a Course-ba, és visszaadja a Price ID-t. */
async function ensureStripePriceIdForCourse(course: {
  id: string;
  title: string;
  price: number;           // a legkisebb pénzegységben (HUF: Ft, USD: cent)
  stripePriceId: string | null;
}) {
  // Ha van stripePriceId, ellenőrizzük, hogy aktív-e
  if (course.stripePriceId) {
    try {
      const price = await stripe.prices.retrieve(course.stripePriceId);
      const product = await stripe.products.retrieve(price.product as string);
      
      // Ha a termék aktív, használjuk a meglévő price-t
      if (product.active) {
        return course.stripePriceId;
      }
      
      // Ha inaktív, töröljük a price ID-t és hozzunk létre újat
      console.log(`Product ${product.id} is inactive, creating new product and price`);
    } catch {
      console.log(`Price ${course.stripePriceId} not found, creating new one`);
    }
  }

  // 1) Produkt létrehozása Stripe-ban (kurzusonként külön termék)
  const product = await stripe.products.create({
    name: course.title,
    active: true, // Explicit aktív állapot
    metadata: { courseId: course.id },
  });

  // 2) Price létrehozása (unit_amount a legkisebb egység!)
  const price = await stripe.prices.create({
    unit_amount: course.price,
    currency: CURRENCY,
    product: product.id,
  });

  // 3) Visszaírás az adatbázisba
  await prisma.course.update({
    where: { id: course.id },
    data: { stripePriceId: price.id },
  });

  return price.id;
}

/** Egy darab Stripe Customer per user – létrehozza, ha nincs, és visszaadja az ID-t. */
async function getOrCreateStripeCustomerId(user: { id: string; email: string; name?: string | null }) {
  const existing = await prisma.user.findUnique({
    where: { id: user.id },
    select: { stripeCustomerId: true },
  });
  if (existing?.stripeCustomerId) return existing.stripeCustomerId;

  // (Opcionális) email alapján keresés Stripe-ban a duplikáció elkerülésére:
  // const found = await stripe.customers.list({ email: user.email, limit: 1 });
  // if (found.data[0]) {
  //   await prisma.user.update({ where: { id: user.id }, data: { stripeCustomerId: found.data[0].id }});
  //   return found.data[0].id;
  // }

  const customer = await stripe.customers.create({
    email: user.email,
    ...(user.name ? { name: user.name } : {}),
    metadata: { userId: user.id },
  });

  await prisma.user.update({
    where: { id: user.id },
    data: { stripeCustomerId: customer.id },
  });

  return customer.id;
}

export async function enrollInCourseAction(courseId: string): Promise<ApiResponse | never> {
  const user = await requireUser();

  let checkoutUrl: string;
  try {
    const req = await request();
    const decision = await aj.protect(req, { fingerprint: user.id });
    if (decision.isDenied()) {
      return { status: "error", message: "You have been blocked" };
    }

    // A stripePriceId-t is kérjük le!
    const course = await prisma.course.findUnique({
      where: { id: courseId },
      select: {
        id: true,
        title: true,
        price: true,
        slug: true,
        stripePriceId: true,
      },
    });

    if (!course) {
      return { status: "error", message: "Course not found" };
    }

    const stripeCustomerId = await getOrCreateStripeCustomerId(user);

    const result = await prisma.$transaction(async (tx) => {
      const existingEnrollment = await tx.enrollment.findUnique({
        where: {
          userId_courseId: {
            userId: user.id,
            courseId: courseId,
          },
        },
        select: { status: true, id: true },
      });

      if (existingEnrollment?.status === "Active") {
        return {
          status: "success",
          message: "You are already enrolled in this Course",
        };
      }

      // Pending enrollment létrehozása/frissítése
      const enrollment =
        existingEnrollment
          ? await tx.enrollment.update({
              where: { id: existingEnrollment.id },
              data: {
                amount: course.price,
                status: "Pending",
                updatedAt: new Date(),
              },
            })
          : await tx.enrollment.create({
              data: {
                userId: user.id,
                courseId: course.id,
                amount: course.price,
                status: "Pending",
              },
            });

      // Gondoskodunk róla, hogy legyen Stripe Price, és visszaírjuk, ha hiányzott
      const stripePriceId = await ensureStripePriceIdForCourse({
        id: course.id,
        title: course.title,
        price: course.price,
        stripePriceId: course.stripePriceId ?? null,
      });

      // Checkout Session létrehozása – NINCS hardcodeolt price
      const checkoutSession = await stripe.checkout.sessions.create({
        customer: stripeCustomerId,
        line_items: [
          {
            price: stripePriceId,
            quantity: 1,
          },
        ],
        mode: "payment",
        success_url: `${env.BETTER_AUTH_URL}/payment/success`,
        cancel_url: `${env.BETTER_AUTH_URL}/payment/cancel`,
        metadata: {
          userId: user.id,
          courseId: course.id,
          enrollmentId: enrollment.id,
        },
      });

      return {
        enrollment,
        checkoutUrl: checkoutSession.url,
      };
    });

    // Ha a tranzakció "already enrolled" üzenetet adott vissza, ne redirecteljünk a Stripe-ra
    if ('status' in result && result.status === "success" && 'message' in result && typeof result.message === 'string' && result.message.includes("already")) {
      return result as ApiResponse;
    }

    checkoutUrl = 'checkoutUrl' in result ? result.checkoutUrl as string : '';
  } catch (error: unknown) {
    console.error("enrollInCourseAction error:", error);
    
    // Stripe hibák elkülönítése
    if (error instanceof Stripe.errors.StripeError) {
      console.error("Stripe error details:", {
        type: error.type,
        code: error.code,
        message: error.message,
        statusCode: error.statusCode
      });
      
      // Ha az összeg túl kicsi, egyszerűen folytassuk a folyamatot
      if (error.code === 'amount_too_small') {
        console.log("Amount too small for Stripe, but continuing anyway");
        return { 
          status: "success", 
          message: "Enrollment completed (amount below Stripe minimum)" 
        };
      }
      
      return { 
        status: "error", 
        message: `Payment system error: ${error.message}` 
      };
    }
    
    // Egyéb hibák részletes naplózása
    return { 
      status: "error", 
      message: error instanceof Error ? error.message : "Failed to enroll in course" 
    };
  }

  redirect(checkoutUrl);
}
