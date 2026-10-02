import { defineCollection, z } from "astro:content";

const postsCollection = defineCollection({
	schema: z.object({
		title: z.string(),
		published: z.date(),
		updated: z.date().optional(),
		draft: z.boolean().optional().default(false),
		description: z.string().optional().default(""),
		image: z.string().optional().default(""),
		tags: z.array(z.string()).optional().default([]),
		category: z.string().optional().nullable().default(""),
		lang: z.string().optional().default(""),

		/* For internal use */
		prevTitle: z.string().default(""),
		prevSlug: z.string().default(""),
		nextTitle: z.string().default(""),
		nextSlug: z.string().default(""),
	}),
});
const specCollection = defineCollection({
	schema: z.object({}),
});
const projectsCollection = defineCollection({
	schema: z.object({
		title: z.string(),
		description: z.string(),
		published: z.date(),
		url: z.string().optional().default(""),
		repo: z.string().optional().default(""),
		tech: z.array(z.string()).optional().default([]),
		status: z.enum(["进行中", "已完成", "维护中", "归档"]).optional().default("进行中"),
		draft: z.boolean().optional().default(false),
	}),
});
const notesCollection = defineCollection({
	schema: z.object({
		title: z.string(),
		published: z.date(),
		draft: z.boolean().optional().default(false),
		tags: z.array(z.string()).optional().default([]),
	}),
});
export const collections = {
	notes: notesCollection,
	posts: postsCollection,
	spec: specCollection,
	projects: projectsCollection,
};
