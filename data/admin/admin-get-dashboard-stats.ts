import "server-only";

import { prisma } from "@/lib/db";
import { requireAdmin } from "./require-admin";

export async function adminGetDashboardStats() {
  await requireAdmin();

  const [totalSignups, totalCustomers, totalCourses, totalLessons] =
    await Promise.all([
      // Total Signups - count of all users
      prisma.user.count(),

      // Total Customers - count of distinct users who have enrollments
      prisma.user.count({
        where: {
          enrollment: {
            some: {},
          },
        },
      }),

      // Total Courses - count of all courses
      prisma.course.count(),

      // Total Lessons - count of all lessons
      prisma.lesson.count(),
    ]);

  return {
    totalSignups,
    totalCustomers,
    totalCourses,
    totalLessons,
  };
}
